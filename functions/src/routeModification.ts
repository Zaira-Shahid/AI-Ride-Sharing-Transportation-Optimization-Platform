import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { LookupLimits } from './lookupLimits.js';
import { buildJourneyStopMatrix, checkCandidateRoute } from './matching.js';
import {
  requestOptimize,
  type CandidateRouteCostBody,
  type OptimizationServiceConfig,
  type RouteMatrixLegBody,
} from './optimizationClient.js';
import { legsForPlanPath } from './optimizationRun.js';
import { checkProtectedConstraints, cumulativeSecondsToStop } from './passengerConstraints.js';
import type { RoutePoint, RoutingProvider } from './routing.js';

// Module 8.7 (route modification): once a driver is flagged behind their plan's own pace (Module
// 8.6, trafficDelay.ts), this is what actually reacts - re-asking the Python optimization service
// (Module 6.9's /optimize) for a fresh best stop order for whoever is still waiting, from the
// driver's CURRENT position rather than their original declared origin, then writing that as a new
// plan version if it is found. Detection (8.6) stays purely observational; this is the only place
// that acts on it. Module 8.9 (notification) is the one that will tell affected passengers.
//
// Scoped deliberately to MATCHING journeys only - nobody yet picked up. An ACTIVE journey (at least
// one passenger already in the vehicle) is out of scope, the same boundary Module 8.4's own insertion
// logic (planInsertion.ts) already drew for exactly the same reason: re-planning around someone
// already onboard is a materially harder problem, left for later. Because of that boundary, "still
// waiting" and "every one of this journey's own matched requests" are the same thing here - there is
// no partial, already-picked-up-but-not-dropped-off passenger to carry through unchanged, which the
// Python service's request-pair-based /optimize could not represent cleanly anyway.
//
// A request the optimizer cannot keep within its own detour limit under the new order is released
// back to SEARCHING (user-approved) - the same "back to the open pool" outcome Module 8.5 (driver
// cancellation) uses, though with its own audit action here since the reason is different (a
// reordering after a delay, not the driver leaving).
//
// Module 8.8 (passenger constraint validation): the candidate plan is also checked against every kept
// request's own protected constraints (allowSharedRide/allowRouteChange/arriveBy,
// passengerConstraints.ts) - see the note beside anyConstraintViolated below for why a violation here
// rejects the whole reorder rather than dropping just the one passenger.

const REORDERABLE_TRIP_STATUSES = new Set(['PICKUP_ASSIGNED', 'DRIVER_ARRIVING']);

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function pointOf(value: unknown): RoutePoint | null {
  if (typeof value !== 'object' || value === null) return null;
  const { latitude, longitude } = value as Record<string, unknown>;
  return isNumber(latitude) && isNumber(longitude) ? { latitude, longitude } : null;
}

interface WaitingRequest {
  id: string;
  passengerId: string;
  origin: RoutePoint;
  destination: RoutePoint;
  passengerMaxExtraMinutes: number;
  passengerMaxDetourDistanceKm: number;
  allowSharedRide: boolean;
  allowRouteChange: boolean;
  arrivalDeadlineMs: number | null;
}

/**
 * Releases one request the reordering could not keep within its own detour limit, back to SEARCHING -
 * the trip-only half of what availability.ts's own releaseMatchedTrips does for Module 8.5, repeated
 * here (rather than reused) only because the audit reason and action name are different: this is a
 * re-ordering after a traffic delay, not the driver going offline, and there is no matching
 * journey-level "cancelled" entry to write since the journey itself stays MATCHING throughout.
 */
function releaseDroppedRequest(
  tx: FirebaseFirestore.Transaction,
  firestore: Firestore,
  trip: FirebaseFirestore.DocumentSnapshot,
  actor: string,
): void {
  const previousStatus = trip.get('status');
  tx.update(trip.ref, {
    status: 'SEARCHING',
    matchedJourneyId: null,
    matchedDriverId: null,
    driverName: null,
    vehicleType: null,
    vehicleMake: null,
    vehicleModel: null,
    vehiclePlateNumber: null,
    driverLocation: null,
    driverDelay: null,
    assignedPlanId: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  tx.create(firestore.collection('auditLogs').doc(), {
    timestamp: FieldValue.serverTimestamp(),
    actor,
    action: 'TRIP_UNMATCHED_ROUTE_MODIFICATION',
    entity: `tripRequests/${trip.id}`,
    previousState: { status: previousStatus },
    newState: { status: 'SEARCHING' },
    reason:
      'Could not stay within their own detour limit on the route re-ordered after a traffic delay',
  });
}

export type RouteModificationOutcome = 'reoptimized' | 'unchanged' | 'skipped';

/**
 * Re-orders `journeyId`'s current plan from the driver's current position, if it is still flagged
 * delayed (Module 8.6) and MATCHING (see the file-level note on why ACTIVE is out of scope). 'skipped'
 * covers every reason this could not even be attempted (not delayed/MATCHING any more, fewer than two
 * still-waiting requests to reorder, a route or the optimization service unavailable); 'unchanged'
 * means the service was asked but returned nothing usable for this journey, so the existing plan and
 * delay flag are left exactly as they were - a later location update can try again. On success, a new
 * journeyPlans version is written (supersedes the old one, same as Module 8.4's own insertions) and the
 * journey's delay flag is cleared: the new plan starts a fresh pace from right now.
 */
export async function reoptimizeDelayedJourney(
  deps: {
    firestore: Firestore;
    provider: RoutingProvider;
    optimizationService: OptimizationServiceConfig;
    limits?: LookupLimits;
    now?: () => number;
  },
  journeyId: string,
): Promise<RouteModificationOutcome> {
  const { firestore } = deps;
  const now = (deps.now ?? Date.now)();
  const journeyRef = firestore.collection('driverJourneys').doc(journeyId);
  const journeySnap = await journeyRef.get();
  if (
    !journeySnap.exists ||
    journeySnap.get('status') !== 'MATCHING' ||
    journeySnap.get('delay') == null
  ) {
    return 'skipped';
  }
  const driverId: unknown = journeySnap.get('driverId');
  const currentLocation = pointOf(journeySnap.get('currentLocation'));
  const destination = pointOf(journeySnap.get('destination'));
  const maxDetourMinutes = journeySnap.get('maxDetourMinutes');
  const maxDetourDistanceKm = journeySnap.get('maxDetourDistance');
  if (
    typeof driverId !== 'string' ||
    !driverId ||
    !currentLocation ||
    !destination ||
    !isNumber(maxDetourMinutes) ||
    !isNumber(maxDetourDistanceKm)
  ) {
    return 'skipped';
  }

  const matchedIds = journeySnap.get('matchedTripRequestIds');
  const ids = (Array.isArray(matchedIds) ? matchedIds : []).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  if (ids.length < 2) return 'skipped';

  const planQuery = await firestore
    .collection('journeyPlans')
    .where('journeyId', '==', journeyId)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  const oldPlanSnap = planQuery.docs[0];
  const oldPlanVersion = oldPlanSnap?.get('version');
  if (!oldPlanSnap || !isNumber(oldPlanVersion)) return 'skipped';
  const oldStops = oldPlanSnap.get('stops');
  const oldStopsArray: Array<{ kind: unknown; requestId: unknown }> = Array.isArray(oldStops)
    ? oldStops
    : [];

  const tripSnaps = await Promise.all(
    ids.map((id) => firestore.collection('tripRequests').doc(id).get()),
  );
  const waiting: WaitingRequest[] = [];
  for (const snap of tripSnaps) {
    if (
      !snap.exists ||
      !REORDERABLE_TRIP_STATUSES.has(snap.get('status')) ||
      snap.get('assignedPlanId') !== oldPlanSnap.id
    ) {
      continue;
    }
    const origin = pointOf(snap.get('origin'));
    const tripDestination = pointOf(snap.get('destination'));
    const passengerId: unknown = snap.get('passengerId');
    const preferences = snap.get('passengerPreferences') as
      | {
          maxExtraTime?: unknown;
          maxDetourDistance?: unknown;
          allowSharedRide?: unknown;
          allowRouteChange?: unknown;
        }
      | undefined;
    const arrivalDeadline: unknown = snap.get('arrivalDeadline');
    if (
      !origin ||
      !tripDestination ||
      typeof passengerId !== 'string' ||
      !passengerId ||
      typeof preferences?.maxExtraTime !== 'number' ||
      typeof preferences?.maxDetourDistance !== 'number' ||
      typeof preferences?.allowSharedRide !== 'boolean' ||
      typeof preferences?.allowRouteChange !== 'boolean'
    ) {
      continue;
    }
    waiting.push({
      id: snap.id,
      passengerId,
      origin,
      destination: tripDestination,
      passengerMaxExtraMinutes: preferences.maxExtraTime,
      passengerMaxDetourDistanceKm: preferences.maxDetourDistance,
      allowSharedRide: preferences.allowSharedRide,
      allowRouteChange: preferences.allowRouteChange,
      arrivalDeadlineMs: arrivalDeadline instanceof Timestamp ? arrivalDeadline.toMillis() : null,
    });
  }
  if (waiting.length < 2) return 'skipped';

  const routeDeps = {
    firestore,
    provider: deps.provider,
    ...(deps.limits ? { limits: deps.limits } : {}),
  };

  // The route cost each still-waiting request now adds from the driver's CURRENT position onward
  // (not their original origin - that leg is already driven). Sequential, never Promise.all: see
  // checkCandidateRoute's own note on the shared route rate limit.
  const costs: CandidateRouteCostBody[] = [];
  for (const request of waiting) {
    const result = await checkCandidateRoute(routeDeps, {
      driverId,
      passengerId: request.passengerId,
      driverOrigin: currentLocation,
      driverDestination: destination,
      passengerPickup: request.origin,
      passengerDestination: request.destination,
      driverMaxDetourMinutes: maxDetourMinutes,
      driverMaxDetourDistanceKm: maxDetourDistanceKm,
      passengerMaxExtraMinutes: request.passengerMaxExtraMinutes,
      passengerMaxDetourDistanceKm: request.passengerMaxDetourDistanceKm,
    });
    if (result.status !== 'checked') continue;
    costs.push({
      request_id: request.id,
      journey_id: journeyId,
      driver_id: driverId,
      additional_distance_meters: result.additionalDistanceMeters,
      additional_duration_seconds: result.additionalDurationSeconds,
      driver_max_detour_minutes: maxDetourMinutes,
      driver_max_detour_distance_km: maxDetourDistanceKm,
      passenger_max_extra_minutes: request.passengerMaxExtraMinutes,
      passenger_max_detour_distance_km: request.passengerMaxDetourDistanceKm,
    });
  }
  if (costs.length < 2) return 'skipped';

  const reachableIds = new Set(costs.map((c) => c.request_id));
  const matrixResult = await buildJourneyStopMatrix(routeDeps, {
    driverId,
    driverOrigin: currentLocation,
    driverDestination: destination,
    requests: waiting
      .filter((r) => reachableIds.has(r.id))
      .map((r) => ({ requestId: r.id, pickup: r.origin, destination: r.destination })),
  });
  if (matrixResult.status !== 'computed') return 'skipped';

  const matrixLegs: RouteMatrixLegBody[] = matrixResult.legs.map((leg) => ({
    from_stop: leg.fromStop,
    to_stop: leg.toStop,
    distance_meters: leg.distanceMeters,
    duration_seconds: leg.durationSeconds,
  }));

  const optimizeResponse = await requestOptimize(deps.optimizationService, {
    request_ids: costs.map((c) => c.request_id),
    costs,
    available_seats: { [journeyId]: costs.length },
    matrices: { [journeyId]: { legs: matrixLegs } },
  });

  const plan = optimizeResponse.plans.find((p) => p.journey_id === journeyId);
  if (!plan || plan.request_ids.length === 0) return 'unchanged';

  const legs = legsForPlanPath(matrixLegs, plan.stops);
  const waitingById = new Map(waiting.map((r) => [r.id, r]));

  // Module 8.8 (passenger constraint validation): checked against the candidate plan Python already
  // returned. Unlike a plain detour-limit violation (which Python itself already resolves before
  // returning - the dropped passenger's own stops are simply absent from plan.stops/totals, so the
  // rest can be written as-is), THIS plan's stops/totals still include everyone Python kept. Dropping
  // just the violator here, without another route call, would leave the written plan's own totals and
  // stop list inconsistent with who it actually carries - so a violation here rejects the WHOLE
  // reorder for this run ('unchanged') rather than a partial write; a later location update can try
  // again, same as every other 'unchanged' reason.
  const shared = plan.request_ids.length > 1;
  const anyConstraintViolated = plan.request_ids.some((requestId) => {
    const request = waitingById.get(requestId);
    if (!request) return true;
    const dropoffIndex = plan.stops.findIndex(
      (stop) => stop.kind === 'dropoff' && stop.request_id === requestId,
    );
    const expectedDropoffAtMs =
      legs && dropoffIndex !== -1
        ? now + cumulativeSecondsToStop(legs, dropoffIndex) * 1000
        : -Infinity;
    const oldPickupIndex = oldStopsArray.findIndex(
      (stop) => stop.kind === 'pickup' && stop.requestId === requestId,
    );
    const oldDropoffIndex = oldStopsArray.findIndex(
      (stop) => stop.kind === 'dropoff' && stop.requestId === requestId,
    );
    const newPickupIndex = plan.stops.findIndex(
      (stop) => stop.kind === 'pickup' && stop.request_id === requestId,
    );
    const routeChangedForThem =
      oldPickupIndex !== newPickupIndex || oldDropoffIndex !== dropoffIndex;
    return (
      checkProtectedConstraints(
        {
          allowSharedRide: request.allowSharedRide,
          allowRouteChange: request.allowRouteChange,
          arrivalDeadlineMs: request.arrivalDeadlineMs,
        },
        { shared, routeChangedForThem, expectedDropoffAtMs },
      ) !== null
    );
  });
  if (anyConstraintViolated) return 'unchanged';

  const keptIds = new Set(plan.request_ids);
  const droppedSnaps = tripSnaps.filter(
    (snap) => waiting.some((r) => r.id === snap.id) && !keptIds.has(snap.id),
  );

  const oldPlanRef = oldPlanSnap.ref;
  const newPlanRef = firestore.collection('journeyPlans').doc();
  const keptTripRefs = plan.request_ids.map((id) => firestore.collection('tripRequests').doc(id));
  const droppedTripRefs = droppedSnaps.map((snap) => snap.ref);

  const applied = await firestore.runTransaction(async (tx) => {
    const [currentJourney, currentOldPlan, currentKeptTrips, currentDroppedTrips] =
      await Promise.all([
        tx.get(journeyRef),
        tx.get(oldPlanRef),
        Promise.all(keptTripRefs.map((ref) => tx.get(ref))),
        Promise.all(droppedTripRefs.map((ref) => tx.get(ref))),
      ]);
    if (
      !currentJourney.exists ||
      currentJourney.get('status') !== 'MATCHING' ||
      currentJourney.get('delay') == null
    ) {
      return false;
    }
    if (!currentOldPlan.exists || currentOldPlan.get('version') !== oldPlanVersion) return false;
    for (const snap of [...currentKeptTrips, ...currentDroppedTrips]) {
      if (
        !snap.exists ||
        !REORDERABLE_TRIP_STATUSES.has(snap.get('status')) ||
        snap.get('assignedPlanId') !== oldPlanSnap.id
      ) {
        return false;
      }
    }

    tx.set(newPlanRef, {
      journeyId,
      driverId,
      requestIds: plan.request_ids,
      stops: plan.stops.map((stop) => ({ kind: stop.kind, requestId: stop.request_id })),
      totalDistanceMeters: plan.total_distance_meters,
      totalDurationSeconds: plan.total_duration_seconds,
      legs,
      version: oldPlanVersion + 1,
      supersedes: oldPlanSnap.id,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(journeyRef, {
      matchedTripRequestIds: plan.request_ids,
      delay: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    for (const ref of keptTripRefs) {
      tx.update(ref, {
        assignedPlanId: newPlanRef.id,
        driverDelay: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    for (const trip of currentDroppedTrips) {
      releaseDroppedRequest(tx, firestore, trip, driverId);
    }
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: driverId,
      action: 'PLAN_REVISED',
      entity: `driverJourneys/${journeyId}`,
      previousState: { planId: oldPlanSnap.id, version: oldPlanVersion },
      newState: { planId: newPlanRef.id, version: oldPlanVersion + 1 },
      reason: 'Route re-ordered after a traffic delay',
    });
    return true;
  });

  return applied ? 'reoptimized' : 'unchanged';
}
