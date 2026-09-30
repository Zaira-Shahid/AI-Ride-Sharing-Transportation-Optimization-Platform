// The HTTP client for the optimization service (Module 6.9, Cloud Functions side, part 2): the two
// endpoints wired up on the Python side (services/optimization/app/main.py) - POST /candidates
// (Module 6.1's cheap proximity filter) and POST /optimize (Modules 6.2-6.8, the actual matching).
// Field names in the request/response bodies below are snake_case on purpose: they must match the
// Python service's pydantic schemas (app/schemas.py) exactly, since that boundary is plain JSON with
// no shared types between the two languages/services.

export interface OptimizationServiceConfig {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** The service's base URL from OPTIMIZATION_SERVICE_URL; null when it is not configured. */
export function optimizationServiceUrlFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return env.OPTIMIZATION_SERVICE_URL?.trim() || null;
}

export const OPTIMIZATION_SERVICE_TIMEOUT_MS = 30_000;

interface Point {
  latitude: number;
  longitude: number;
}

export interface CandidatesRequestBody {
  requests: Array<{ id: string; origin: Point; destination: Point }>;
  journeys: Array<{
    id: string;
    driver_id: string;
    origin: Point | null;
    destination: Point | null;
    available_seats: number | null;
  }>;
}

export interface CandidateBody {
  request_id: string;
  journey_id: string;
  driver_id: string;
  distance_meters: number;
  bearing_difference_degrees: number;
}

export interface CandidatesResponseBody {
  candidates: CandidateBody[];
}

export interface CandidateRouteCostBody {
  request_id: string;
  journey_id: string;
  driver_id: string;
  additional_distance_meters: number;
  additional_duration_seconds: number;
  driver_max_detour_minutes: number;
  driver_max_detour_distance_km: number;
  passenger_max_extra_minutes: number;
  passenger_max_detour_distance_km: number;
}

export interface RouteMatrixLegBody {
  from_stop: string;
  to_stop: string;
  distance_meters: number;
  duration_seconds: number;
}

export interface OptimizeRequestBody {
  request_ids: string[];
  costs: CandidateRouteCostBody[];
  available_seats: Record<string, number>;
  matrices: Record<string, { legs: RouteMatrixLegBody[] }>;
}

export interface StopBody {
  kind: string;
  request_id: string;
}

export interface JourneyPlanBody {
  journey_id: string;
  driver_id: string;
  stops: StopBody[];
  request_ids: string[];
  dropped_request_ids: string[];
  total_distance_meters: number;
  total_duration_seconds: number;
}

export interface RequestExplanationBody {
  request_id: string;
  status: string;
  journey_id: string | null;
  reason: string;
}

export interface PlanValidationIssueBody {
  journey_id: string;
  reason: string;
}

export interface RunSummaryBody {
  requested_count: number;
  matched_count: number;
  dropped_after_sharing_count: number;
  unmatched_count: number;
  unmatched_by_reason: Record<string, number>;
  journeys_used: number;
  total_distance_meters: number;
  total_duration_seconds: number;
  validation_issue_count: number;
  run_duration_seconds: number;
}

export interface OptimizeResponseBody {
  plans: JourneyPlanBody[];
  explanations: RequestExplanationBody[];
  validation_issues: PlanValidationIssueBody[];
  summary: RunSummaryBody;
}

async function postJson<T>(
  config: OptimizationServiceConfig,
  path: string,
  body: unknown,
): Promise<T> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? OPTIMIZATION_SERVICE_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`The optimization service answered ${response.status} for ${path}.`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Module 6.1's cheap candidate filter, over the network. */
export function requestCandidates(
  config: OptimizationServiceConfig,
  body: CandidatesRequestBody,
): Promise<CandidatesResponseBody> {
  return postJson(config, '/candidates', body);
}

/** Modules 6.2-6.8 - constraints through the run summary - in one call. */
export function requestOptimize(
  config: OptimizationServiceConfig,
  body: OptimizeRequestBody,
): Promise<OptimizeResponseBody> {
  return postJson(config, '/optimize', body);
}

// Phase 13 (AI/ML, module app/ml/routes.py): the ETA and cancellation prototypes, both trained on
// SYNTHETIC data only. Every response body below carries `prototype: true` and
// `trained_on: "synthetic_data"` - the Python service's own hard requirement (app/ml/schemas.py) -
// and mlPredictions.ts's own header comment names the same hard boundary these fields exist to
// enforce: nothing that reads these responses may feed a real matching, payment or notification
// decision.

async function getJson<T>(config: OptimizationServiceConfig, path: string): Promise<T> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? OPTIMIZATION_SERVICE_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`The optimization service answered ${response.status} for ${path}.`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface MlStatusBody {
  prototype: true;
  trained_on: 'synthetic_data';
  trained_at: string;
  trained_row_count: number;
  data_source: string;
  eta_validation_mean_absolute_error_seconds: number;
  cancellation_validation_auc: number;
  warning: string;
}

export interface MlPredictionRequestBody {
  distance_km: number;
  hour_of_day: number;
  day_of_week: number;
  naive_duration_seconds: number;
}

export interface EtaPredictionBody {
  predicted_duration_seconds: number;
  prototype: true;
  trained_on: 'synthetic_data';
}

export interface CancellationPredictionBody {
  cancellation_risk: number;
  prototype: true;
  trained_on: 'synthetic_data';
}

/** GET /ml/status - model metadata, training data provenance, and validation metrics. */
export function requestMlStatus(config: OptimizationServiceConfig): Promise<MlStatusBody> {
  return getJson(config, '/ml/status');
}

/** POST /ml/eta/predict - the ETA prototype's own prediction for a single, manually entered trip. */
export function requestEtaPrediction(
  config: OptimizationServiceConfig,
  body: MlPredictionRequestBody,
): Promise<EtaPredictionBody> {
  return postJson(config, '/ml/eta/predict', body);
}

/** POST /ml/cancellation/predict - the cancellation prototype's own risk score for a single trip. */
export function requestCancellationPrediction(
  config: OptimizationServiceConfig,
  body: MlPredictionRequestBody,
): Promise<CancellationPredictionBody> {
  return postJson(config, '/ml/cancellation/predict', body);
}
