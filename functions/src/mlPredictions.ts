import { HttpsError } from 'firebase-functions/v2/https';
import {
  requestCancellationPrediction,
  requestEtaPrediction,
  requestMlStatus,
  type MlPredictionRequestBody,
  type OptimizationServiceConfig,
} from './optimizationClient.js';
import { isStaffRole } from './roles.js';
import type { StaffCaller } from './verification.js';

// Phase 13 (AI/ML). User-confirmed scope: ETA prediction + cancellation prediction only (demand
// prediction, route compatibility, and network forecasting are all explicitly deferred). Both
// models are trained on SYNTHETIC data only (services/optimization/app/ml/__init__.py) - never on
// a real trip, because none exist yet at a scale worth training on. THE HARD BOUNDARY (spec section
// 32, mirrored exactly, not relaxed for convenience): this file's own three exports are read by the
// admin dashboard's own "AI Predictions" page ONLY - visibility and demonstration only. Nothing
// here is called from anywhere else in this codebase, and no real matching, payment or notification
// decision may ever read a response from here.
//
// Access: any staff role may call these (visibility-only, the same stance as trip monitoring/
// optimization monitoring/analytics) - there is nothing to authorize beyond "is staff", since
// nothing here changes any state.

export interface MlStatus {
  prototype: true;
  trainedOn: 'synthetic_data';
  trainedAt: string;
  trainedRowCount: number;
  dataSource: string;
  etaValidationMeanAbsoluteErrorSeconds: number;
  cancellationValidationAuc: number;
  warning: string;
}

export interface MlPredictionInput {
  distanceKm: number;
  hourOfDay: number;
  dayOfWeek: number;
  naiveDurationSeconds: number;
}

export interface EtaPrediction {
  predictedDurationSeconds: number;
  prototype: true;
  trainedOn: 'synthetic_data';
}

export interface CancellationPrediction {
  cancellationRisk: number;
  prototype: true;
  trainedOn: 'synthetic_data';
}

function requireStaff(caller: StaffCaller): void {
  if (!isStaffRole(caller.role) || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'You are not allowed to view AI predictions.');
  }
}

function requireServiceConfig(config: OptimizationServiceConfig | null): OptimizationServiceConfig {
  if (!config) {
    throw new HttpsError(
      'failed-precondition',
      'The AI prediction prototype is not available yet.',
    );
  }
  return config;
}

function requestBodyFrom(input: MlPredictionInput): MlPredictionRequestBody {
  return {
    distance_km: input.distanceKm,
    hour_of_day: input.hourOfDay,
    day_of_week: input.dayOfWeek,
    naive_duration_seconds: input.naiveDurationSeconds,
  };
}

export async function getMlStatusForStaff(
  deps: { optimizationService: OptimizationServiceConfig | null },
  caller: StaffCaller,
): Promise<MlStatus> {
  requireStaff(caller);
  const config = requireServiceConfig(deps.optimizationService);
  const body = await requestMlStatus(config);
  return {
    prototype: body.prototype,
    trainedOn: body.trained_on,
    trainedAt: body.trained_at,
    trainedRowCount: body.trained_row_count,
    dataSource: body.data_source,
    etaValidationMeanAbsoluteErrorSeconds: body.eta_validation_mean_absolute_error_seconds,
    cancellationValidationAuc: body.cancellation_validation_auc,
    warning: body.warning,
  };
}

export async function predictEtaForStaff(
  deps: { optimizationService: OptimizationServiceConfig | null },
  caller: StaffCaller,
  input: MlPredictionInput,
): Promise<EtaPrediction> {
  requireStaff(caller);
  const config = requireServiceConfig(deps.optimizationService);
  const body = await requestEtaPrediction(config, requestBodyFrom(input));
  return {
    predictedDurationSeconds: body.predicted_duration_seconds,
    prototype: body.prototype,
    trainedOn: body.trained_on,
  };
}

export async function predictCancellationForStaff(
  deps: { optimizationService: OptimizationServiceConfig | null },
  caller: StaffCaller,
  input: MlPredictionInput,
): Promise<CancellationPrediction> {
  requireStaff(caller);
  const config = requireServiceConfig(deps.optimizationService);
  const body = await requestCancellationPrediction(config, requestBodyFrom(input));
  return {
    cancellationRisk: body.cancellation_risk,
    prototype: body.prototype,
    trainedOn: body.trained_on,
  };
}
