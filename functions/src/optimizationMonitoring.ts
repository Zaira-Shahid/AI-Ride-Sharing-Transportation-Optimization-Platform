import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { isStaffRole } from './roles.js';
import type { StaffCaller } from './verification.js';

// Module 11.9 (admin dashboard: optimization monitoring). Spec section 24 ("Optimization Control
// Center") asks for a run-level summary (cycle ID, time started, requests/drivers/candidates/plans
// evaluated, plans rejected, constraints triggered, final assignments, execution time) and a
// per-decision list (passenger, driver, compatibility %, additional distance/time, passenger walking,
// seats used, reason). Checked against what the optimization service (Module 6.9) actually computes
// today, and against optimizationRun.ts itself, which discarded all of it after every batch run - no
// optimizationRuns document (named in the spec's own schema list, section 27) was ever written.
//
// User-approved scope (a plain-text exchange, same pattern as every module this phase): (a) skip
// logging an "empty" cycle - one that evaluated 0 open requests or 0 available journeys - there is
// nothing to show; (b) a query-time retention limit (this list, not deletion) from the start: the last
// OPTIMIZATION_RUNS_RETENTION_LIMIT runs, or ones started within OPTIMIZATION_RUNS_RETENTION_DAYS,
// whichever is fewer - actual deletion needs a scheduled function (Blaze plan), the same known gap as
// the geocoding/routing caches and trip-request coordinates (docs/security.md); (c) any staff role may
// read this, the same as trip monitoring - inspection only, no financial or verification decision; (d)
// two of the spec's own per-decision fields have no real number behind them and are never fabricated:
// "compatibility %" is not a score this system computes anywhere, and "passenger walking" distance is
// a preference ceiling set at trip-request time (Module 5.2), never recomputed live during a match.
// Seats used is shown per PLAN (request count vs. the journey's own seat capacity), not per decision,
// since it is a property of the plan a request landed in, not of the request alone.

export const OPTIMIZATION_RUNS_COLLECTION = 'optimizationRuns';
export const OPTIMIZATION_RUNS_RETENTION_LIMIT = 500;
export const OPTIMIZATION_RUNS_RETENTION_DAYS = 30;

/** One request's outcome in a cycle - the optimizer's own proposal, from `explanations` and `costs`. */
export interface OptimizationRunDecision {
  requestId: string;
  status: string;
  reason: string;
  journeyId: string | null;
  driverId: string | null;
  /** Only for a request the optimizer matched: the real added distance/time for that specific pairing. */
  additionalDistanceMeters: number | null;
  additionalDurationSeconds: number | null;
  /** The plan the request landed in, if any: how many seats it used out of the journey's own capacity. */
  seatsUsed: number | null;
  seatsAvailable: number | null;
  planTotalDistanceMeters: number | null;
  planTotalDurationSeconds: number | null;
}

/** One batch-optimization cycle (Module 8.1's phase 1 only - phase 2's insertion is a different, simpler heuristic with no optimizer call, so it has none of this to log). */
export interface OptimizationRunLog {
  startedAt: number;
  requestsEvaluated: number;
  journeysEvaluated: number;
  candidatesGenerated: number;
  plansGenerated: number;
  plansRejected: number;
  /** The optimizer's own breakdown of why an unmatched request stayed unmatched - real, not a single invented "constraints triggered" count. */
  unmatchedByReason: Record<string, number>;
  /** The requests actually assigned in Firestore (not the optimizer's own proposal - see the note where this is written). */
  finalAssignments: number;
  journeysMatched: number;
  /** The optimization service's own reported time for the /optimize call alone, not this whole cycle (candidate discovery and route-matrix building happen before it, and are not included). */
  executionTimeSeconds: number;
  decisions: OptimizationRunDecision[];
}

export interface OptimizationRunRow extends OptimizationRunLog {
  runId: string;
}

function requireStaff(caller: StaffCaller): void {
  if (!isStaffRole(caller.role) || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'You are not allowed to view optimization runs.');
  }
}

/** Writes one cycle's log. Never audited (a system record of what the optimizer did, not a staff decision) and never throws into the caller's own batch run - a logging failure should not undo a real match. */
export async function writeOptimizationRunLog(
  firestore: Firestore,
  log: OptimizationRunLog,
): Promise<void> {
  await firestore
    .collection(OPTIMIZATION_RUNS_COLLECTION)
    .add({ ...log, startedAt: Timestamp.fromMillis(log.startedAt) })
    .catch(() => undefined);
}

/**
 * Every optimization cycle, newest first, capped by OPTIMIZATION_RUNS_RETENTION_LIMIT and
 * OPTIMIZATION_RUNS_RETENTION_DAYS (whichever cuts first) - a query-time limit only; nothing deletes
 * an old run yet (see this file's own header comment). Not paginated: the cap keeps this small enough
 * for one call, the same shape listActiveTripsForStaff/listDisputedTrips already use.
 */
export async function listOptimizationRunsForStaff(
  deps: { firestore: Firestore; now?: () => number },
  caller: StaffCaller,
): Promise<OptimizationRunRow[]> {
  requireStaff(caller);
  const now = (deps.now ?? Date.now)();
  const cutoff = Timestamp.fromMillis(now - OPTIMIZATION_RUNS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const snapshot = await deps.firestore
    .collection(OPTIMIZATION_RUNS_COLLECTION)
    .where('startedAt', '>=', cutoff)
    .orderBy('startedAt', 'desc')
    .limit(OPTIMIZATION_RUNS_RETENTION_LIMIT)
    .get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    const startedAt = data.startedAt as Timestamp;
    return {
      runId: doc.id,
      startedAt: startedAt.toMillis(),
      requestsEvaluated: typeof data.requestsEvaluated === 'number' ? data.requestsEvaluated : 0,
      journeysEvaluated: typeof data.journeysEvaluated === 'number' ? data.journeysEvaluated : 0,
      candidatesGenerated:
        typeof data.candidatesGenerated === 'number' ? data.candidatesGenerated : 0,
      plansGenerated: typeof data.plansGenerated === 'number' ? data.plansGenerated : 0,
      plansRejected: typeof data.plansRejected === 'number' ? data.plansRejected : 0,
      unmatchedByReason:
        typeof data.unmatchedByReason === 'object' && data.unmatchedByReason !== null
          ? (data.unmatchedByReason as Record<string, number>)
          : {},
      finalAssignments: typeof data.finalAssignments === 'number' ? data.finalAssignments : 0,
      journeysMatched: typeof data.journeysMatched === 'number' ? data.journeysMatched : 0,
      executionTimeSeconds:
        typeof data.executionTimeSeconds === 'number' ? data.executionTimeSeconds : 0,
      decisions: Array.isArray(data.decisions) ? (data.decisions as OptimizationRunDecision[]) : [],
    };
  });
}
