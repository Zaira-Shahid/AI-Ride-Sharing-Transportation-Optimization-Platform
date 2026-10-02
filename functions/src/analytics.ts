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
// pass builds exactly Phase 12's own 12 named metrics, no more, no fewer - "network efficiency"
// (section 23) belongs to the live network dashboard instead (functions/src/liveNetwork.ts), and the
// fuller section 78/33 metric sets are explicitly a later, separate decision, not part of this;
// (b) "Average passenger walking distance" is skipped, same
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
  /** Null once the distinct counts are capped: people transported is then only a lower bound, so a difference made from it would be wrong, not just rough. */
  vehicleTripsAvoided: number | null;
  averageDetourMeters: number | null;
  averageDetourSeconds: number | null;
  averageMatchingTimeSeconds: number | null;
  unmatchedRequests: number;
  cancellationRate: number | null;
  paymentSuccessRate: number | null;
  /** True when there are more completed trips than `distinctTripCap`, so `peopleTransported` and `vehiclesUsed` count only the most recent ones (at least that many). */
  distinctCountsCapped: boolean;
  distinctTripCap: number;
  /** Null when there is nothing to estimate from (no completed trips, or none ever avoided, or the distinct counts are capped). Always labeled as an estimate on the page - see this file's own header comment. */
  estimatedEmissionsAvoidedKg: number | null;
}

function requireStaff(caller: StaffCaller): void {
  if (!isStaffRole(caller.role) || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'You are not allowed to view analytics.');
  }
}

/**
 * Phase 14 (performance, spec section 71 "avoid unbounded queries"): how many of the most recent
 * COMPLETED trips the distinct counts read. Firestore has no count-distinct aggregate, so "people
 * transported" and "vehicles used" had to read every completed trip on every call. They now read the
 * newest this many. Up to that many completed trips the numbers are exact and nothing changes; beyond
 * it they are lower bounds, the summary says so (`distinctCountsCapped`), and the two figures that are
 * a difference made from them (trips avoided, and the emissions estimate built on it) are withheld
 * rather than shown wrong - `max(0, people - journeys)` against an all-time journey count would
 * quietly read 0. The real cure at that scale is a running counter, not a bigger cap.
 */
export const ANALYTICS_DISTINCT_TRIP_CAP = 5_000;

/**
 * The distinct passengers and the distinct drivers across the newest `cap` COMPLETED trip requests, in
 * ONE read (both fields from the same documents). Asks for one more than `cap`, which is how it is
 * known there were more.
 */
async function distinctCompletedParticipants(
  firestore: Firestore,
  cap: number,
): Promise<{ passengers: Set<string>; drivers: Set<string>; capped: boolean }> {
  const snapshot = await firestore
    .collection('tripRequests')
    .where('status', '==', 'COMPLETED')
    .orderBy('createdAt', 'desc')
    .limit(cap + 1)
    .select('passengerId', 'matchedDriverId')
    .get();
  const passengers = new Set<string>();
  const drivers = new Set<string>();
  for (const doc of snapshot.docs.slice(0, cap)) {
    const passengerId = doc.get('passengerId');
    const driverId = doc.get('matchedDriverId');
    if (typeof passengerId === 'string' && passengerId) passengers.add(passengerId);
    if (typeof driverId === 'string' && driverId) drivers.add(driverId);
  }
  return { passengers, drivers, capped: snapshot.size > cap };
}

export async function getAnalyticsSummaryForStaff(
  deps: {
    firestore: Firestore;
    /** Only a test changes this (see ANALYTICS_DISTINCT_TRIP_CAP). */
    distinctTripCap?: number;
  },
  caller: StaffCaller,
): Promise<AnalyticsSummary> {
  requireStaff(caller);
  const { firestore } = deps;
  const distinctTripCap = deps.distinctTripCap ?? ANALYTICS_DISTINCT_TRIP_CAP;
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
    distinct,
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
    distinctCompletedParticipants(firestore, distinctTripCap),
    firestore
      .collection(OPTIMIZATION_RUNS_COLLECTION)
      .orderBy('startedAt', 'desc')
      .limit(OPTIMIZATION_RUNS_RETENTION_LIMIT)
      .get(),
  ]);

  const tripsCompleted = tripsCompletedAgg.data().count;
  const completedJourneys = completedJourneysAgg.data().count;
  const peopleTransported = distinct.passengers.size;
  const vehiclesUsed = distinct.drivers.size;
  const averageOccupancy = completedJourneys > 0 ? tripsCompleted / completedJourneys : null;
  // Withheld, not shown wrong, once the distinct counts are capped (see ANALYTICS_DISTINCT_TRIP_CAP).
  const vehicleTripsAvoided = distinct.capped
    ? null
    : Math.max(0, peopleTransported - completedJourneys);

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
    vehicleTripsAvoided !== null && vehicleTripsAvoided > 0 && averageDistanceMeters !== null
      ? (vehicleTripsAvoided * (averageDistanceMeters / 1000) * ASSUMED_CO2_GRAMS_PER_KM) / 1000
      : null;

  return {
    tripsCompleted,
    peopleTransported,
    vehiclesUsed,
    averageOccupancy,
    vehicleTripsAvoided,
    distinctCountsCapped: distinct.capped,
    distinctTripCap,
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
