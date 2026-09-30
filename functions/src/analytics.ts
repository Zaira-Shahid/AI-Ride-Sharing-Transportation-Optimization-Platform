import { AggregateField, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { isStaffRole } from './roles.js';
import {
  OPTIMIZATION_RUNS_COLLECTION,
  OPTIMIZATION_RUNS_RETENTION_LIMIT,
} from './optimizationMonitoring.js';
import type { StaffCaller } from './verification.js';

// Module 12 (Analytics). Phase 12's own 12-metric list, checked against the spec, and against what
// Disputes/Trip Monitoring/Optimization Monitoring/Payments (Phase 11) already cover: none of them
// expose an aggregate, platform-wide number like this - every one of them lists individual trips/runs.
// User-approved scope (a plain-text exchange, same pattern as every module this phase): (a) this
// pass builds exactly Phase 12's own 12 named metrics, no more, no fewer - the spec's own separate
// "network efficiency" (section 23) and the fuller section 78/33 metric sets are explicitly a later,
// separate decision, not part of this; (b) "Average passenger walking distance" is skipped, same
// stance as 11.9's own "compatibility %"/"walking distance" refusal - no live walking-distance number
// is computed anywhere in this codebase, so none is shown, rather than presenting a passenger's own
// preference ceiling as if it were a measured outcome; (c) any staff role may read this - visibility
// only, the same as trip monitoring/optimization monitoring.
//
// Definitions the user chose (documented here, in packages/types/src/analytics.ts, and on the admin
// page itself - these are OUR OWN choices, not industry-standard formulas):
// - "People transported" / "Vehicles used": DISTINCT passengers / DISTINCT drivers across COMPLETED
//   trips, not raw trip counts.
// - "Average occupancy": completed trips (rides) / completed journeys - a per-journey-LIFETIME
//   average (how many riders a journey served across its whole life), not a moment-in-time seat count.
// - "Vehicle trips avoided": people transported (the distinct-passenger count above) minus completed
//   journeys - i.e., how many fewer vehicle-journeys were needed than if every transported passenger
//   had needed their own. A simplification: a repeat passenger's own later ride only adds a journey,
//   never a new "distinct passenger", so this slightly UNDERCOUNTS trips avoided compared to counting
//   every ride; the alternative (raw completed-trip count instead of distinct passengers) would
//   overcount for the same reason. Neither is "the" right answer; this is the one chosen.
// - "Estimated emissions avoided": vehicle trips avoided x average trip distance (from this system's
//   own stored route estimates) x an ASSUMED 120 g CO2/km per car (a commonly cited average car
//   figure, not measured or verified for this fleet). Spec section 33 requires estimates like this to
//   be labeled as such and never presented as exact - the admin page does that prominently; this is
//   not a verified methodology.
// - "Average matching time": requestedAt to matchedAt (module 12's own new matchedAt/
//   matchDurationSeconds fields on tripRequests, written by optimizationRun.ts's phase 1 and
//   planInsertion.ts's phase 2 - nothing tracked this before, and it is NOT retroactive: a trip
//   matched before this shipped has no matchDurationSeconds and is excluded from the average.
// - "Average detour": the real added distance/time for every MATCHED decision in optimizationRuns
//   (module 11.9's own per-cycle log), averaged across whatever cycles that module's own retention
//   window still holds (the same OPTIMIZATION_RUNS_RETENTION_LIMIT/_DAYS cap, not a separate one) -
//   not retroactive before 11.9 either, and a genuinely different (smaller, more recent) population
//   than the trip-level metrics above, which is unavoidable given where this data actually lives.
// - "Unmatched requests": a LIVE snapshot (currently REQUESTED or SEARCHING), not a historical count -
//   the same choice trip monitoring's own "live" view already makes for the same status set.
// - "Cancellation rate" / "Payment success rate": CANCELLED / (CANCELLED + COMPLETED), and
//   successful-payment statuses / (successful + FAILED) - trips/payments that never resolved
//   (still open, or payment never attempted) are excluded from either denominator.

const COMPLETED_PAYMENT_STATUSES = ['CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;
/** A commonly cited average car CO2 figure - an assumption, not measured for this fleet (see the file header). */
const ASSUMED_CO2_GRAMS_PER_KM = 120;

export interface AnalyticsSummary {
  tripsCompleted: number;
  peopleTransported: number;
  vehiclesUsed: number;
  averageOccupancy: number | null;
  vehicleTripsAvoided: number;
  averageDetourMeters: number | null;
  averageDetourSeconds: number | null;
  averageMatchingTimeSeconds: number | null;
  unmatchedRequests: number;
  cancellationRate: number | null;
  paymentSuccessRate: number | null;
  /** Null when there is nothing to estimate from (no completed trips, or none ever avoided). Always labeled as an estimate on the page - see this file's own header comment. */
  estimatedEmissionsAvoidedKg: number | null;
}

function requireStaff(caller: StaffCaller): void {
  if (!isStaffRole(caller.role) || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'You are not allowed to view analytics.');
  }
}

/** Distinct values of `field` across every COMPLETED trip request - Firestore has no count-distinct aggregate, so this reads every matching document. Known simplification: unbounded at scale (see docs/security.md). */
async function distinctCompletedValues(firestore: Firestore, field: string): Promise<Set<string>> {
  const snapshot = await firestore
    .collection('tripRequests')
    .where('status', '==', 'COMPLETED')
    .select(field)
    .get();
  const values = new Set<string>();
  for (const doc of snapshot.docs) {
    const value = doc.get(field);
    if (typeof value === 'string' && value) values.add(value);
  }
  return values;
}

export async function getAnalyticsSummaryForStaff(
  deps: { firestore: Firestore },
  caller: StaffCaller,
): Promise<AnalyticsSummary> {
  requireStaff(caller);
  const { firestore } = deps;
  const trips = firestore.collection('tripRequests');
  const completed = trips.where('status', '==', 'COMPLETED');

  const [
    tripsCompletedAgg,
    completedJourneysAgg,
    averageDistanceAgg,
    averageMatchingAgg,
    unmatchedAgg,
    cancelledAgg,
    resolvedAgg,
    paymentSuccessAgg,
    paymentAttemptedAgg,
    distinctPassengers,
    distinctDrivers,
    recentRuns,
  ] = await Promise.all([
    completed.count().get(),
    firestore.collection('driverJourneys').where('status', '==', 'COMPLETED').count().get(),
    completed.aggregate({ avg: AggregateField.average('estimatedDistance') }).get(),
    trips
      .where('matchDurationSeconds', '>=', 0)
      .aggregate({ avg: AggregateField.average('matchDurationSeconds') })
      .get(),
    trips.where('status', 'in', ['REQUESTED', 'SEARCHING']).count().get(),
    trips.where('status', '==', 'CANCELLED').count().get(),
    trips.where('status', 'in', ['CANCELLED', 'COMPLETED']).count().get(),
    trips
      .where('paymentStatus', 'in', [...COMPLETED_PAYMENT_STATUSES])
      .count()
      .get(),
    trips
      .where('paymentStatus', 'in', [...COMPLETED_PAYMENT_STATUSES, 'FAILED'])
      .count()
      .get(),
    distinctCompletedValues(firestore, 'passengerId'),
    distinctCompletedValues(firestore, 'matchedDriverId'),
    firestore
      .collection(OPTIMIZATION_RUNS_COLLECTION)
      .orderBy('startedAt', 'desc')
      .limit(OPTIMIZATION_RUNS_RETENTION_LIMIT)
      .get(),
  ]);

  const tripsCompleted = tripsCompletedAgg.data().count;
  const completedJourneys = completedJourneysAgg.data().count;
  const peopleTransported = distinctPassengers.size;
  const vehiclesUsed = distinctDrivers.size;
  const averageOccupancy = completedJourneys > 0 ? tripsCompleted / completedJourneys : null;
  const vehicleTripsAvoided = Math.max(0, peopleTransported - completedJourneys);

  const detourDistances: number[] = [];
  const detourDurations: number[] = [];
  for (const doc of recentRuns.docs) {
    const decisions = doc.get('decisions');
    if (!Array.isArray(decisions)) continue;
    for (const decision of decisions) {
      if (decision?.status !== 'matched') continue;
      if (typeof decision.additionalDistanceMeters === 'number') {
        detourDistances.push(decision.additionalDistanceMeters);
      }
      if (typeof decision.additionalDurationSeconds === 'number') {
        detourDurations.push(decision.additionalDurationSeconds);
      }
    }
  }
  const average = (values: number[]) =>
    values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null;

  const cancelledCount = cancelledAgg.data().count;
  const resolvedCount = resolvedAgg.data().count;
  const paymentSuccessCount = paymentSuccessAgg.data().count;
  const paymentAttemptedCount = paymentAttemptedAgg.data().count;

  const averageDistanceMeters = averageDistanceAgg.data().avg;
  const estimatedEmissionsAvoidedKg =
    vehicleTripsAvoided > 0 && averageDistanceMeters !== null
      ? (vehicleTripsAvoided * (averageDistanceMeters / 1000) * ASSUMED_CO2_GRAMS_PER_KM) / 1000
      : null;

  return {
    tripsCompleted,
    peopleTransported,
    vehiclesUsed,
    averageOccupancy,
    vehicleTripsAvoided,
    averageDetourMeters: average(detourDistances),
    averageDetourSeconds: average(detourDurations),
    averageMatchingTimeSeconds: averageMatchingAgg.data().avg,
    unmatchedRequests: unmatchedAgg.data().count,
    cancellationRate: resolvedCount > 0 ? cancelledCount / resolvedCount : null,
    paymentSuccessRate:
      paymentAttemptedCount > 0 ? paymentSuccessCount / paymentAttemptedCount : null,
    estimatedEmissionsAvoidedKg,
  };
}
