// The batch optimization run (Module 6.9, Cloud Functions side, part 2): gathers every SEARCHING
// trip request and AVAILABLE journey, calls the optimization service's two endpoints
// (optimizationClient.ts), and writes the results back to Firestore. Wired to a scheduled trigger in
// index.ts (Module 6.10); it replaced Module 5.5's automatic per-request matching, which is no longer
// called from anywhere in production.
//
// The route cost per candidate reuses checkCandidateRoute (Module 5.4) - same calculateRoute calls,
// just without deciding compatibility itself, since that decision now belongs to the optimization
// service (Module 6.2). The stop matrix per journey (buildJourneyStopMatrix, Module 6.9 part 1) is
// asked for every journey that has at least one candidate with a computed cost - a safe superset of
// the journeys the optimizer might actually use, since which ones it keeps is not known until inside
// requestOptimize itself.
//
// A kept plan is written as its own journeyPlans/{planId} document (holding the actual stop order -
// tripRequests.assignedPlanId, added in Module 3.7, was always waiting for exactly this), plus the
// usual matchedJourneyId/matchedDriverId on each trip request and matchedTripRequestIds on the
// journey - same MATCHING status the journey has always used, just for more than one request at once.
// A trip request goes straight to PICKUP_ASSIGNED, not MATCHED (Module 7.1): its place in the stop
// order is already fixed by the plan at the moment of assignment, so there is no separate "matched
// but pickup not yet set" moment to represent (see the TRIP_STATUS_TRANSITIONS comment in
// tripRequests.ts). A transaction re-checks the journey is still AVAILABLE and every one of its
// requests is still SEARCHING and unassigned before writing, since the pool may have moved on since
// the batch snapshot was taken.

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  checkCandidateRoute,
  buildJourneyStopMatrix,
  dropoffStop,
  pickupStop,
  DESTINATION_STOP,
  ORIGIN_STOP,
} from './matching.js';
import type { LookupLimits } from './lookupLimits.js';
import {
  requestCandidates,
  requestOptimize,
  type CandidateRouteCostBody,
  type JourneyPlanBody,
  type OptimizationServiceConfig,
  type RouteMatrixLegBody,
} from './optimizationClient.js';
import { tryInsertIntoMatchingJourney, type PlanLeg } from './planInsertion.js';
import type { RoutePoint, RoutingProvider } from './routing.js';
import { firstNameOf } from './tripRequests.js';

/**
 * Module 8.6 (traffic delay): the per-leg distance/duration along `plan`'s own winning stop order,
 * looked up in the same full stop-to-stop matrix (buildJourneyStopMatrix, module 6.9) already computed
 * to let the optimization service choose that order in the first place - the Python service's own
 * /optimize response carries only the plan's totals, not a leg breakdown, so this is how the totals
 * are recovered as legs. Null if a leg cannot be found (defensive only - should not happen, since the
 * matrix was built from these same requests); a plan written without legs just cannot be delay-checked
 * later (locations.ts skips it gracefully), nothing else about it is affected.
 *
 * Exported for routeModification.ts (module 8.7): recovering a leg breakdown the same way from a
 * /optimize response is exactly what it also needs, for the same reason.
 */
export function legsForPlanPath(
  matrixLegs: readonly RouteMatrixLegBody[],
  stops: JourneyPlanBody['stops'],
): PlanLeg[] | null {
  const path = [
    ORIGIN_STOP,
    ...stops.map((stop) => (stop.kind === 'pickup' ? pickupStop : dropoffStop)(stop.request_id)),
    DESTINATION_STOP,
  ];
  const legs: PlanLeg[] = [];
  for (let i = 0; i < path.length - 1; i += 1) {
    const leg = matrixLegs.find((l) => l.from_stop === path[i] && l.to_stop === path[i + 1]);
    if (!leg) return null;
    legs.push({ distanceMeters: leg.distance_meters, durationSeconds: leg.duration_seconds });
  }
  return legs;
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function pointOf(value: unknown): RoutePoint | null {
  if (typeof value !== 'object' || value === null) return null;
  const { latitude, longitude } = value as Record<string, unknown>;
  return isNumber(latitude) && isNumber(longitude) ? { latitude, longitude } : null;
}

interface OpenTripRequest {
  id: string;
  passengerId: string;
  origin: RoutePoint;
  destination: RoutePoint;
  passengerMaxExtraMinutes: number;
  passengerMaxDetourDistanceKm: number;
  /**
   * The request's own direct pickup-to-destination distance/time (Module 4.4) - null until the
   * estimate trigger has filled it in, or if it could not be. Only phase 2 (insertStillSearching
   * Requests) needs these, for a still-searching request's own detour; phase 1 does not.
   */
  estimatedDistanceMeters: number | null;
  estimatedDurationSeconds: number | null;
}

interface AvailableJourney {
  id: string;
  driverId: string;
  origin: RoutePoint;
  destination: RoutePoint;
  availableSeats: number;
  maxDetourMinutes: number;
  maxDetourDistanceKm: number;
}

async function readOpenTripRequests(firestore: Firestore): Promise<OpenTripRequest[]> {
  const snapshot = await firestore
    .collection('tripRequests')
    .where('status', '==', 'SEARCHING')
    .get();
  const requests: OpenTripRequest[] = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const origin = pointOf(data.origin);
    const destination = pointOf(data.destination);
    const passengerId: unknown = data.passengerId;
    const preferences = data.passengerPreferences as
      { maxExtraTime?: unknown; maxDetourDistance?: unknown } | undefined;
    if (
      !origin ||
      !destination ||
      typeof passengerId !== 'string' ||
      !passengerId ||
      typeof preferences?.maxExtraTime !== 'number' ||
      typeof preferences?.maxDetourDistance !== 'number'
    ) {
      continue;
    }
    requests.push({
      id: doc.id,
      passengerId,
      origin,
      destination,
      passengerMaxExtraMinutes: preferences.maxExtraTime,
      passengerMaxDetourDistanceKm: preferences.maxDetourDistance,
      estimatedDistanceMeters: isNumber(data.estimatedDistance) ? data.estimatedDistance : null,
      estimatedDurationSeconds: isNumber(data.estimatedDuration) ? data.estimatedDuration : null,
    });
  }
  return requests;
}

async function readAvailableJourneys(firestore: Firestore): Promise<AvailableJourney[]> {
  const snapshot = await firestore
    .collection('driverJourneys')
    .where('status', '==', 'AVAILABLE')
    .get();
  const journeys: AvailableJourney[] = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const origin = pointOf(data.origin);
    const destination = pointOf(data.destination);
    const driverId: unknown = data.driverId;
    const availableSeats = data.availableSeats;
    const maxDetourMinutes = data.maxDetourMinutes;
    const maxDetourDistance = data.maxDetourDistance;
    if (
      !origin ||
      !destination ||
      typeof driverId !== 'string' ||
      !driverId ||
      typeof availableSeats !== 'number' ||
      availableSeats < 1 ||
      typeof maxDetourMinutes !== 'number' ||
      typeof maxDetourDistance !== 'number'
    ) {
      continue;
    }
    journeys.push({
      id: doc.id,
      driverId,
      origin,
      destination,
      availableSeats,
      maxDetourMinutes,
      maxDetourDistanceKm: maxDetourDistance,
    });
  }
  return journeys;
}

export interface BatchOptimizationOutcome {
  requestCount: number;
  journeyCount: number;
  matchedRequestCount: number;
  matchedJourneyCount: number;
  /** Still-searching requests fitted into an already-MATCHING journey instead (modules 8.3/8.4). */
  insertedRequestCount: number;
}

/**
 * Phase 1: matches SEARCHING requests into fresh AVAILABLE journeys, through the Python optimization
 * service (Module 6.9) - everything this file did before modules 8.3/8.4. Unchanged; called by the
 * public runBatchOptimization below, which adds phase 2 (insertion into already-MATCHING journeys)
 * afterwards, for whatever this phase leaves still searching.
 */
async function matchIntoAvailableJourneys(deps: {
  firestore: Firestore;
  provider: RoutingProvider;
  optimizationService: OptimizationServiceConfig;
  limits?: LookupLimits;
  now?: () => number;
}): Promise<Omit<BatchOptimizationOutcome, 'insertedRequestCount'>> {
  const { firestore } = deps;
  const routeDeps = {
    firestore,
    provider: deps.provider,
    ...(deps.limits ? { limits: deps.limits } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };

  const [requests, journeys] = await Promise.all([
    readOpenTripRequests(firestore),
    readAvailableJourneys(firestore),
  ]);
  const empty: Omit<BatchOptimizationOutcome, 'insertedRequestCount'> = {
    requestCount: requests.length,
    journeyCount: journeys.length,
    matchedRequestCount: 0,
    matchedJourneyCount: 0,
  };
  if (requests.length === 0 || journeys.length === 0) return empty;

  const requestById = new Map(requests.map((r) => [r.id, r]));
  const journeyById = new Map(journeys.map((j) => [j.id, j]));

  const candidatesResponse = await requestCandidates(deps.optimizationService, {
    requests: requests.map((r) => ({ id: r.id, origin: r.origin, destination: r.destination })),
    journeys: journeys.map((j) => ({
      id: j.id,
      driver_id: j.driverId,
      origin: j.origin,
      destination: j.destination,
      available_seats: j.availableSeats,
    })),
  });
  if (candidatesResponse.candidates.length === 0) return empty;

  // Sequential, never in parallel: see checkCandidateRoute's own note on the shared rate limit.
  const costs: CandidateRouteCostBody[] = [];
  for (const candidate of candidatesResponse.candidates) {
    const request = requestById.get(candidate.request_id);
    const journey = journeyById.get(candidate.journey_id);
    if (!request || !journey) continue;

    const result = await checkCandidateRoute(routeDeps, {
      driverId: journey.driverId,
      passengerId: request.passengerId,
      driverOrigin: journey.origin,
      driverDestination: journey.destination,
      passengerPickup: request.origin,
      passengerDestination: request.destination,
      driverMaxDetourMinutes: journey.maxDetourMinutes,
      driverMaxDetourDistanceKm: journey.maxDetourDistanceKm,
      passengerMaxExtraMinutes: request.passengerMaxExtraMinutes,
      passengerMaxDetourDistanceKm: request.passengerMaxDetourDistanceKm,
    });
    if (result.status !== 'checked') continue;

    costs.push({
      request_id: candidate.request_id,
      journey_id: candidate.journey_id,
      driver_id: candidate.driver_id,
      additional_distance_meters: result.additionalDistanceMeters,
      additional_duration_seconds: result.additionalDurationSeconds,
      driver_max_detour_minutes: journey.maxDetourMinutes,
      driver_max_detour_distance_km: journey.maxDetourDistanceKm,
      passenger_max_extra_minutes: request.passengerMaxExtraMinutes,
      passenger_max_detour_distance_km: request.passengerMaxDetourDistanceKm,
    });
  }
  if (costs.length === 0) return empty;

  const journeyIdsWithCosts = [...new Set(costs.map((c) => c.journey_id))];
  const matrices: Record<string, { legs: RouteMatrixLegBody[] }> = {};
  for (const journeyId of journeyIdsWithCosts) {
    const journey = journeyById.get(journeyId);
    if (!journey) continue;
    const requestsForJourney = costs
      .filter((c) => c.journey_id === journeyId)
      .map((c) => requestById.get(c.request_id))
      .filter((r): r is OpenTripRequest => r != null);

    const matrixResult = await buildJourneyStopMatrix(routeDeps, {
      driverId: journey.driverId,
      driverOrigin: journey.origin,
      driverDestination: journey.destination,
      requests: requestsForJourney.map((r) => ({
        requestId: r.id,
        pickup: r.origin,
        destination: r.destination,
      })),
    });
    if (matrixResult.status !== 'computed') continue;

    matrices[journeyId] = {
      legs: matrixResult.legs.map((leg) => ({
        from_stop: leg.fromStop,
        to_stop: leg.toStop,
        distance_meters: leg.distanceMeters,
        duration_seconds: leg.durationSeconds,
      })),
    };
  }

  const costsWithMatrix = costs.filter((c) => matrices[c.journey_id] !== undefined);
  if (costsWithMatrix.length === 0) return empty;

  const availableSeats: Record<string, number> = {};
  for (const journeyId of Object.keys(matrices)) {
    availableSeats[journeyId] = journeyById.get(journeyId)?.availableSeats ?? 0;
  }

  const optimizeResponse = await requestOptimize(deps.optimizationService, {
    request_ids: requests.map((r) => r.id),
    costs: costsWithMatrix,
    available_seats: availableSeats,
    matrices,
  });

  let matchedRequestCount = 0;
  let matchedJourneyCount = 0;
  for (const plan of optimizeResponse.plans) {
    if (plan.request_ids.length === 0) continue;

    const journeyRef = firestore.collection('driverJourneys').doc(plan.journey_id);
    const tripRefs = plan.request_ids.map((id) => firestore.collection('tripRequests').doc(id));
    const planRef = firestore.collection('journeyPlans').doc();
    const driverUserRef = firestore.collection('users').doc(plan.driver_id);
    const vehicleRef = firestore.collection('vehicles').doc(plan.driver_id);
    const legs = legsForPlanPath(matrices[plan.journey_id]?.legs ?? [], plan.stops);

    const applied = await firestore.runTransaction(async (tx) => {
      const [journeySnap, tripSnaps, driverUserSnap, vehicleSnap] = await Promise.all([
        tx.get(journeyRef),
        Promise.all(tripRefs.map((ref) => tx.get(ref))),
        tx.get(driverUserRef),
        tx.get(vehicleRef),
      ]);
      if (!journeySnap.exists || journeySnap.get('status') !== 'AVAILABLE') return false;
      for (const tripSnap of tripSnaps) {
        if (
          !tripSnap.exists ||
          tripSnap.get('status') !== 'SEARCHING' ||
          tripSnap.get('matchedJourneyId') != null
        ) {
          return false;
        }
      }

      const driverName = firstNameOf(driverUserSnap.get('name'), 'Driver');
      const vehicleType = (vehicleSnap.get('type') as string | undefined) ?? null;
      const vehicleMake = (vehicleSnap.get('make') as string | undefined) ?? null;
      const vehicleModel = (vehicleSnap.get('model') as string | undefined) ?? null;
      const vehiclePlateNumber = (vehicleSnap.get('plateNumber') as string | undefined) ?? null;

      tx.set(planRef, {
        journeyId: plan.journey_id,
        driverId: plan.driver_id,
        requestIds: plan.request_ids,
        stops: plan.stops.map((stop) => ({ kind: stop.kind, requestId: stop.request_id })),
        totalDistanceMeters: plan.total_distance_meters,
        totalDurationSeconds: plan.total_duration_seconds,
        // Module 8.6 (traffic delay): null when a leg could not be recovered from the matrix -
        // deliberately not a hard failure, see legsForPlanPath's own note.
        legs,
        // Module 8.3 (plan versioning): a journey's very first plan is always version 1, with
        // nothing before it. A later one - so far only module 8.4's own insertion into an
        // already-MATCHING journey - starts a new version, superseding this one.
        version: 1,
        supersedes: null,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.update(journeyRef, {
        status: 'MATCHING',
        matchedTripRequestIds: plan.request_ids,
        updatedAt: FieldValue.serverTimestamp(),
      });
      for (const tripRef of tripRefs) {
        tx.update(tripRef, {
          status: 'PICKUP_ASSIGNED',
          matchedJourneyId: plan.journey_id,
          matchedDriverId: plan.driver_id,
          assignedPlanId: planRef.id,
          driverName,
          vehicleType,
          vehicleMake,
          vehicleModel,
          vehiclePlateNumber,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return true;
    });

    if (applied) {
      matchedRequestCount += plan.request_ids.length;
      matchedJourneyCount += 1;
    }
  }

  return {
    requestCount: requests.length,
    journeyCount: journeys.length,
    matchedRequestCount,
    matchedJourneyCount,
  };
}

/**
 * Phase 2 (modules 8.3/8.4): whatever is left SEARCHING after phase 1 gets one attempt each at
 * fitting into an already-MATCHING journey with room (planInsertion.ts), instead of only ever
 * matching into a fresh AVAILABLE one. A fresh read, not phase 1's own in-memory list: simpler than
 * threading "which of phase 1's own requests got matched" through its several early returns, and the
 * SEARCHING collection this reads is small. One request at a time, sequential (never Promise.all -
 * the same shared route rate limit reasoning as everywhere else this file calls calculateRoute), so
 * an earlier request's own insertion is committed, and that journey's seats reduced, before the next
 * one is considered.
 */
async function insertStillSearchingRequests(deps: {
  firestore: Firestore;
  provider: RoutingProvider;
  limits?: LookupLimits;
}): Promise<number> {
  const stillSearching = await readOpenTripRequests(deps.firestore);
  let insertedRequestCount = 0;
  for (const request of stillSearching) {
    if (request.estimatedDistanceMeters === null || request.estimatedDurationSeconds === null) {
      continue;
    }
    const outcome = await tryInsertIntoMatchingJourney(deps, {
      id: request.id,
      passengerId: request.passengerId,
      origin: request.origin,
      destination: request.destination,
      estimatedDistanceMeters: request.estimatedDistanceMeters,
      estimatedDurationSeconds: request.estimatedDurationSeconds,
      passengerMaxExtraMinutes: request.passengerMaxExtraMinutes,
      passengerMaxDetourDistanceKm: request.passengerMaxDetourDistanceKm,
    });
    if (outcome === 'inserted') insertedRequestCount += 1;
  }
  return insertedRequestCount;
}

/**
 * The batch optimization run (Module 6.9, widened by modules 8.3/8.4): phase 1 matches SEARCHING
 * requests into fresh AVAILABLE journeys (matchIntoAvailableJourneys, unchanged); phase 2 tries to
 * fit whatever is still searching afterwards into an already-MATCHING journey with room instead
 * (insertStillSearchingRequests). Called by both the periodic schedule and the immediate trigger
 * (optimizationTrigger.ts, modules 8.1/8.2).
 */
export async function runBatchOptimization(deps: {
  firestore: Firestore;
  provider: RoutingProvider;
  optimizationService: OptimizationServiceConfig;
  limits?: LookupLimits;
  now?: () => number;
}): Promise<BatchOptimizationOutcome> {
  const phase1 = await matchIntoAvailableJourneys(deps);
  const insertedRequestCount = await insertStillSearchingRequests(deps);
  return { ...phase1, insertedRequestCount };
}
