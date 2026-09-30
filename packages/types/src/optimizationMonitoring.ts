// Module 11.9 (admin dashboard: optimization monitoring). See
// functions/src/optimizationMonitoring.ts's own comment for the scope this was checked and agreed
// against - the shape here matches what that function actually returns.

export const OPTIMIZATION_RUNS_RETENTION_LIMIT = 500;
export const OPTIMIZATION_RUNS_RETENTION_DAYS = 30;

/** One request's outcome in a cycle - the optimizer's own proposal. */
export interface OptimizationRunDecision {
  requestId: string;
  status: string;
  reason: string;
  journeyId: string | null;
  driverId: string | null;
  additionalDistanceMeters: number | null;
  additionalDurationSeconds: number | null;
  seatsUsed: number | null;
  seatsAvailable: number | null;
  planTotalDistanceMeters: number | null;
  planTotalDurationSeconds: number | null;
}

/** One batch-optimization cycle, as staff see it. */
export interface OptimizationRunRow {
  runId: string;
  startedAt: number;
  requestsEvaluated: number;
  journeysEvaluated: number;
  candidatesGenerated: number;
  plansGenerated: number;
  plansRejected: number;
  unmatchedByReason: Record<string, number>;
  finalAssignments: number;
  journeysMatched: number;
  executionTimeSeconds: number;
  decisions: OptimizationRunDecision[];
}
