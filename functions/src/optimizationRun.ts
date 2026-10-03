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

import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
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
import {
  type OptimizationRunDecision,
  type OptimizationRunLog,
  writeOptimizationRunLog,
} from './optimizationMonitoring.js';
import { checkProtectedConstraints, cumulativeSecondsToStop } from './passengerConstraints.js';
import { tryInsertIntoMatchingJourney, type PlanLeg } from './planInsertion.js';
import { sendPushToUser } from './pushNotifications.js';
import type { PushProvider } from './pushProvider.js';
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

/**
 * Module 8.8 (passenger constraint validation): whether any request in `plan` would have its own
 * protected constraints violated by it - allowSharedRide, allowRouteChange or its own arriveBy
 * deadline (checkProtectedConstraints, passengerConstraints.ts). A first-time match is never itself a
 * "route change" for anyone in it (routeChangedForThem: false throughout - see that file's own note),
 * so only allowSharedRide and the deadline can ever trip here. When `legs` could not be recovered
 * (legsForPlanPath returned null), the deadline cannot be checked either - true only in that case,
 * same "cannot verify, so do not flag" stance Module 8.6's own computeDelayFlag takes.
 *
 * Unlike Module 8.7's own reordering, a single journey's plan here is all-or-nothing: if any one
 * request in it would be violated, the whole plan for that journey is skipped and every one of its
 * requests stays SEARCHING for a later run, rather than trying to reconstruct a smaller plan without
 * them - the Python service already committed to this exact assignment, and there is no cheap way to
 * remove one stop and re-derive a valid new stop order/totals on the TS side the way Module 8.7's own
 * reorder (a fresh /optimize call) can.
 */
function planViolatesProtectedConstraints(
  plan: JourneyPlanBody,
  legs: PlanLeg[] | null,
  requestById: ReadonlyMap<string, OpenTripRequest>,
  now: number,
): boolean {
  const shared = plan.request_ids.length > 1;
  return plan.request_ids.some((requestId) => {
    const request = requestById.get(requestId);
    if (!request) return false;
    const dropoffIndex = plan.stops.findIndex(
      (stop) => stop.kind === 'dropoff' && stop.request_id === requestId,
    );
    const expectedDropoffAtMs =
      legs && dropoffIndex !== -1
        ? now + cumulativeSecondsToStop(legs, dropoffIndex) * 1000
        : -Infinity;
    return (
      checkProtectedConstraints(
        {
          allowSharedRide: request.allowSharedRide,
          allowRouteChange: request.allowRouteChange,
          arrivalDeadlineMs: request.arrivalDeadlineMs,
        },
        { shared, routeChangedForThem: false, expectedDropoffAtMs },
      ) !== null
    );
  });
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
  /** Module 8.8 (passenger constraint validation): the three protected constraints, unchecked until now. */
  allowSharedRide: boolean;
  allowRouteChange: boolean;
  arrivalDeadlineMs: number | null;
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
      | {
          maxExtraTime?: unknown;
          maxDetourDistance?: unknown;
          allowSharedRide?: unknown;
          allowRouteChange?: unknown;
        }
      | undefined;
    const arrivalDeadline: unknown = data.arrivalDeadline;
    if (
      !origin ||
      !destination ||
      typeof passengerId !== 'string' ||
      !passengerId ||
      typeof preferences?.maxExtraTime !== 'number' ||
      typeof preferences?.maxDetourDistance !== 'number' ||
      typeof preferences?.allowSharedRide !== 'boolean' ||
      typeof preferences?.allowRouteChange !== 'boolean'
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
      allowSharedRide: preferences.allowSharedRide,
      allowRouteChange: preferences.allowRouteChange,
      arrivalDeadlineMs: arrivalDeadline instanceof Timestamp ? arrivalDeadline.toMillis() : null,
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
  /**
   * Phase 14 observability (spec section 54's own `optimizationRunId` correlation ID): the
   * optimizationRuns/{id} document this cycle wrote, logged alongside the Cloud Logging entry for
   * this run (index.ts) so the two can be found from one another. Null when nothing was logged (an
   * empty cycle - see matchIntoAvailableJourneys's own note) or the log write itself failed.
   */
  optimizationRunId: string | null;
  /**
   * Spec section 54's `requestId` and `planId` correlation IDs: the requests this run assigned (matched
   * into a fresh journey or inserted into a matching one) and the journeyPlans documents it wrote for
   * them, logged with the rest of this outcome so a request or a plan can be found in Cloud Logging
   * and traced to the run (optimizationRunId) that made it. Only ids, never a place.
   */
  requestIds: string[];
  planIds: string[];
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
  push: PushProvider;
  limits?: LookupLimits;
  now?: () => number;
}): Promise<Omit<BatchOptimizationOutcome, 'insertedRequestCount'>> {
  const { firestore } = deps;
  const cycleStartedAt = (deps.now ?? Date.now)();
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
    optimizationRunId: null,
    requestIds: [],
    planIds: [],
  };
  // Module 11.9 (optimization monitoring): an empty cycle (nothing to evaluate at all) is not logged -
  // there is nothing to show a staff account. Every other early return below DID evaluate real
  // requests/journeys, so each logs a cycle with whatever partial counts it reached.
  if (requests.length === 0 || journeys.length === 0) return empty;

  const logCycle = (
    partial: Partial<
      Omit<OptimizationRunLog, 'startedAt' | 'requestsEvaluated' | 'journeysEvaluated'>
    >,
  ) =>
    writeOptimizationRunLog(firestore, {
      startedAt: cycleStartedAt,
      requestsEvaluated: requests.length,
      journeysEvaluated: journeys.length,
      candidatesGenerated: 0,
      plansGenerated: 0,
      plansRejected: 0,
      unmatchedByReason: {},
      finalAssignments: 0,
      journeysMatched: 0,
      executionTimeSeconds: 0,
      decisions: [],
      ...partial,
    });

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
  if (candidatesResponse.candidates.length === 0) {
    const optimizationRunId = await logCycle({});
    return { ...empty, optimizationRunId };
  }

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
  if (costs.length === 0) {
    const optimizationRunId = await logCycle({
      candidatesGenerated: candidatesResponse.candidates.length,
    });
    return { ...empty, optimizationRunId };
  }

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
  if (costsWithMatrix.length === 0) {
    const optimizationRunId = await logCycle({
      candidatesGenerated: candidatesResponse.candidates.length,
    });
    return { ...empty, optimizationRunId };
  }

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

  const now = (deps.now ?? Date.now)();
  let matchedRequestCount = 0;
  let matchedJourneyCount = 0;
  const requestIds: string[] = [];
  const planIds: string[] = [];
  for (const plan of optimizeResponse.plans) {
    if (plan.request_ids.length === 0) continue;

    const journeyRef = firestore.collection('driverJourneys').doc(plan.journey_id);
    const tripRefs = plan.request_ids.map((id) => firestore.collection('tripRequests').doc(id));
    const planRef = firestore.collection('journeyPlans').doc();
    const driverUserRef = firestore.collection('users').doc(plan.driver_id);
    const vehicleRef = firestore.collection('vehicles').doc(plan.driver_id);
    const legs = legsForPlanPath(matrices[plan.journey_id]?.legs ?? [], plan.stops);
    if (planViolatesProtectedConstraints(plan, legs, requestById, now)) continue;

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
      for (let i = 0; i < tripRefs.length; i += 1) {
        const tripRef = tripRefs[i]!;
        // Module 12 (analytics): matchedAt/matchDurationSeconds are new here - real time-to-match
        // data for "average matching time", which nothing tracked before (no other write here is
        // audited either, so there was no timestamp anywhere else to reuse). `now` (not
        // serverTimestamp) so the duration can be computed in the same write; requestedAt already
        // exists on every trip request (module 3's own creation field).
        const requestedAt = tripSnaps[i]?.get('requestedAt') as
          { toMillis: () => number } | undefined;
        const matchDurationSeconds =
          requestedAt && typeof requestedAt.toMillis === 'function'
            ? Math.max(0, (now - requestedAt.toMillis()) / 1000)
            : null;
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
          // Module 9.3: this journey has more than one passenger from the moment this plan is
          // written if OR-Tools itself pooled several requests together in one batch run.
          sharedRide: plan.request_ids.length > 1,
          matchedAt: Timestamp.fromMillis(now),
          matchDurationSeconds,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return true;
    });

    if (applied) {
      matchedRequestCount += plan.request_ids.length;
      matchedJourneyCount += 1;
      requestIds.push(...plan.request_ids);
      planIds.push(planRef.id);

      // Module 10.3 (trip matched push): sent AFTER the transaction above commits (a network call,
      // never inside a Firestore transaction) - one push to the driver (count-based, since OR-Tools
      // may have pooled several passengers into this one plan) and one to each newly matched
      // passenger. sendPushToUser never throws and no-ops for anyone with no saved token.
      const passengerCount = plan.request_ids.length;
      await Promise.all([
        sendPushToUser(deps, plan.driver_id, {
          title: 'New passenger' + (passengerCount > 1 ? 's' : ''),
          body:
            passengerCount === 1
              ? "You've been matched with 1 passenger."
              : `You've been matched with ${passengerCount} passengers.`,
        }),
        ...plan.request_ids.map((requestId) => {
          const passengerId = requestById.get(requestId)?.passengerId;
          if (!passengerId) return Promise.resolve();
          return sendPushToUser(deps, passengerId, {
            title: 'Trip matched',
            body: "You've been matched with a driver.",
          });
        }),
      ]);
    }
  }

  // Module 11.9 (optimization monitoring): the optimizer's own proposal (explanations/costs/plans),
  // enriched with the real added distance/time for a matched pairing and the plan it landed in. Note
  // that "matched" here is the OPTIMIZER's own status, not a cross-check against `applied` above - the
  // rare case where a proposed plan's own transaction did not apply (another change landed first) is
  // not reconciled per decision; finalAssignments/journeysMatched below are the real, applied counts.
  const costByKey = new Map(costsWithMatrix.map((c) => [`${c.request_id}:${c.journey_id}`, c]));
  const planByRequestId = new Map<string, JourneyPlanBody>();
  for (const plan of optimizeResponse.plans) {
    for (const requestId of plan.request_ids) planByRequestId.set(requestId, plan);
  }
  const decisions: OptimizationRunDecision[] = optimizeResponse.explanations.map((explanation) => {
    const cost = explanation.journey_id
      ? costByKey.get(`${explanation.request_id}:${explanation.journey_id}`)
      : undefined;
    const plan = planByRequestId.get(explanation.request_id);
    return {
      requestId: explanation.request_id,
      status: explanation.status,
      reason: explanation.reason,
      journeyId: explanation.journey_id,
      driverId: explanation.journey_id
        ? (journeyById.get(explanation.journey_id)?.driverId ?? null)
        : null,
      additionalDistanceMeters: cost?.additional_distance_meters ?? null,
      additionalDurationSeconds: cost?.additional_duration_seconds ?? null,
      seatsUsed: plan ? plan.request_ids.length : null,
      seatsAvailable: plan ? (availableSeats[plan.journey_id] ?? null) : null,
      planTotalDistanceMeters: plan?.total_distance_meters ?? null,
      planTotalDurationSeconds: plan?.total_duration_seconds ?? null,
    };
  });
  const optimizationRunId = await logCycle({
    candidatesGenerated: candidatesResponse.candidates.length,
    plansGenerated: optimizeResponse.plans.length,
    plansRejected: optimizeResponse.validation_issues.length,
    unmatchedByReason: optimizeResponse.summary.unmatched_by_reason,
    finalAssignments: matchedRequestCount,
    journeysMatched: matchedJourneyCount,
    executionTimeSeconds: optimizeResponse.summary.run_duration_seconds,
    decisions,
  });

  return {
    requestCount: requests.length,
    journeyCount: journeys.length,
    matchedRequestCount,
    matchedJourneyCount,
    optimizationRunId,
    requestIds,
    planIds,
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
  push: PushProvider;
  limits?: LookupLimits;
  now?: () => number;
}): Promise<{ requestIds: string[]; planIds: string[] }> {
  const stillSearching = await readOpenTripRequests(deps.firestore);
  const requestIds: string[] = [];
  const planIds: string[] = [];
  for (const request of stillSearching) {
    if (request.estimatedDistanceMeters === null || request.estimatedDurationSeconds === null) {
      continue;
    }
    const outcome = await tryInsertIntoMatchingJourney(
      { ...deps, onPlanWritten: (planId) => planIds.push(planId) },
      {
        id: request.id,
        passengerId: request.passengerId,
        origin: request.origin,
        destination: request.destination,
        estimatedDistanceMeters: request.estimatedDistanceMeters,
        estimatedDurationSeconds: request.estimatedDurationSeconds,
        passengerMaxExtraMinutes: request.passengerMaxExtraMinutes,
        passengerMaxDetourDistanceKm: request.passengerMaxDetourDistanceKm,
        allowSharedRide: request.allowSharedRide,
        allowRouteChange: request.allowRouteChange,
        arrivalDeadlineMs: request.arrivalDeadlineMs,
      },
    );
    if (outcome === 'inserted') requestIds.push(request.id);
  }
  return { requestIds, planIds };
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
  push: PushProvider;
  limits?: LookupLimits;
  now?: () => number;
}): Promise<BatchOptimizationOutcome> {
  const phase1 = await matchIntoAvailableJourneys(deps);
  const inserted = await insertStillSearchingRequests(deps);
  return {
    ...phase1,
    insertedRequestCount: inserted.requestIds.length,
    requestIds: [...phase1.requestIds, ...inserted.requestIds],
    planIds: [...phase1.planIds, ...inserted.planIds],
  };
}
