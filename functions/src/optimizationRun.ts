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
import { checkCandidateRoute, buildJourneyStopMatrix } from './matching.js';
import type { LookupLimits } from './lookupLimits.js';
import {
  requestCandidates,
  requestOptimize,
  type CandidateRouteCostBody,
  type OptimizationServiceConfig,
  type RouteMatrixLegBody,
} from './optimizationClient.js';
import type { RoutePoint, RoutingProvider } from './routing.js';

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
}

export async function runBatchOptimization(deps: {
  firestore: Firestore;
  provider: RoutingProvider;
  optimizationService: OptimizationServiceConfig;
  limits?: LookupLimits;
  now?: () => number;
}): Promise<BatchOptimizationOutcome> {
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
  const empty: BatchOptimizationOutcome = {
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

    const applied = await firestore.runTransaction(async (tx) => {
      const [journeySnap, tripSnaps] = await Promise.all([
        tx.get(journeyRef),
        Promise.all(tripRefs.map((ref) => tx.get(ref))),
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

      tx.set(planRef, {
        journeyId: plan.journey_id,
        driverId: plan.driver_id,
        requestIds: plan.request_ids,
        stops: plan.stops.map((stop) => ({ kind: stop.kind, requestId: stop.request_id })),
        totalDistanceMeters: plan.total_distance_meters,
        totalDurationSeconds: plan.total_duration_seconds,
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
