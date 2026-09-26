import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { LookupLimits } from './lookupLimits.js';
import { findCandidateJourneys, type CandidateSourceJourney } from './matching.js';
import {
  createNotification,
  notifyWithPush,
  sendQueuedPushes,
  type PendingPush,
} from './notifications.js';
import { checkProtectedConstraints, cumulativeSecondsToStop } from './passengerConstraints.js';
import { sendPushToUser } from './pushNotifications.js';
import type { PushProvider } from './pushProvider.js';
import { calculateRoute, type RoutePoint, type RoutingProvider } from './routing.js';
import { firstNameOf } from './tripRequests.js';

// Modules 8.3 (plan versioning) and 8.4 (new passenger insertion), together: tries to fit a
// still-SEARCHING request into an already-MATCHING journey with room, rather than only ever matching
// into a fresh AVAILABLE one (Module 6.9's own job, run first and left untouched - this only looks at
// whatever is STILL searching once that has already had its turn). Deliberately TS-only, not the
// Python optimization service: a MATCHING journey's own plan is already fixed for its existing
// passengers, so this is "where does one more stop pair fit into an already-decided sequence", not a
// fresh assignment problem - small enough (a MATCHING journey has at most a handful of stops) for a
// direct brute-force search over insertion positions, checking every affected passenger's own detour
// limits (and the driver's) under the new combined route, not just the new passenger's own. ACTIVE
// journeys (the driver has already picked someone up) are out of scope: re-planning from the driver's
// live position, with someone already onboard, is a materially harder and riskier problem, left for
// later.
//
// A successful insertion writes a NEW journeyPlans document (version = old + 1, supersedes = the old
// plan's id) rather than editing the old one - Module 8.3's own decision: plans are kept forever, an
// immutable history, and the client already reads whichever is newest for a journey (Module 7.1's
// journeyPlan.ts), so nothing else needs to change to pick this up.

export const INSERTION_CANDIDATES_CHECKED = 3;

/** A plan's own per-leg breakdown (module 8.6, traffic delay) - one entry per consecutive stop pair. */
export interface PlanLeg {
  distanceMeters: number;
  durationSeconds: number;
}

interface StopEntry {
  kind: 'pickup' | 'dropoff';
  requestId: string;
}

/** Module 8.8 (passenger constraint validation): the protected fields, on both a new and an existing passenger. */
interface ProtectedFields {
  allowSharedRide: boolean;
  allowRouteChange: boolean;
  arrivalDeadlineMs: number | null;
}

/** The parts of a still-SEARCHING request insertion needs. */
export interface InsertableTrip extends ProtectedFields {
  id: string;
  passengerId: string;
  origin: RoutePoint;
  destination: RoutePoint;
  /** The request's own direct pickup-to-destination distance/time (Module 4.4), for its own detour. */
  estimatedDistanceMeters: number;
  estimatedDurationSeconds: number;
  passengerMaxExtraMinutes: number;
  passengerMaxDetourDistanceKm: number;
}

interface ExistingPassenger extends ProtectedFields {
  id: string;
  passengerId: string;
  origin: RoutePoint;
  destination: RoutePoint;
  estimatedDistanceMeters: number;
  estimatedDurationSeconds: number;
  passengerMaxExtraMinutes: number;
  passengerMaxDetourDistanceKm: number;
}

interface MatchingJourneyPlan {
  planId: string;
  journeyId: string;
  driverId: string;
  origin: RoutePoint;
  destination: RoutePoint;
  availableSeats: number;
  maxDetourMinutes: number;
  maxDetourDistanceKm: number;
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  version: number;
  stops: StopEntry[];
  existingPassengers: Map<string, ExistingPassenger>;
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function pointOf(value: unknown): RoutePoint | null {
  if (typeof value !== 'object' || value === null) return null;
  const { latitude, longitude } = value as Record<string, unknown>;
  return isNumber(latitude) && isNumber(longitude) ? { latitude, longitude } : null;
}

function stopPoint(stop: StopEntry, passengers: Map<string, ExistingPassenger>): RoutePoint | null {
  const passenger = passengers.get(stop.requestId);
  if (!passenger) return null;
  return stop.kind === 'pickup' ? passenger.origin : passenger.destination;
}

/** Every stop list with `pickup` and `dropoff` inserted somewhere, pickup always before dropoff. */
function* insertionCandidates(
  existing: StopEntry[],
  pickup: StopEntry,
  dropoff: StopEntry,
): Generator<StopEntry[]> {
  for (let p = 0; p <= existing.length; p += 1) {
    const withPickup = [...existing.slice(0, p), pickup, ...existing.slice(p)];
    for (let d = p + 1; d <= withPickup.length; d += 1) {
      yield [...withPickup.slice(0, d), dropoff, ...withPickup.slice(d)];
    }
  }
}

/**
 * Reads every MATCHING journey with at least one spare seat, its current plan (the newest for that
 * journey, same query as the client's own useJourneyPlanStops - Module 7.1), and every one of its
 * existing passengers' own places, estimate and preferences. A journey whose plan or any of whose
 * existing passengers cannot be read is skipped (defensive only - should not happen in practice).
 */
async function readMatchingJourneyPlans(firestore: Firestore): Promise<MatchingJourneyPlan[]> {
  const journeysSnapshot = await firestore
    .collection('driverJourneys')
    .where('status', '==', 'MATCHING')
    .get();

  const plans: MatchingJourneyPlan[] = [];
  for (const journeyDoc of journeysSnapshot.docs) {
    const data = journeyDoc.data();
    const origin = pointOf(data.origin);
    const destination = pointOf(data.destination);
    const availableSeats = data.availableSeats;
    const maxDetourMinutes = data.maxDetourMinutes;
    const maxDetourDistance = data.maxDetourDistance;
    const matchedTripRequestIds = data.matchedTripRequestIds;
    if (
      !origin ||
      !destination ||
      !isNumber(availableSeats) ||
      !isNumber(maxDetourMinutes) ||
      !isNumber(maxDetourDistance) ||
      !Array.isArray(matchedTripRequestIds) ||
      matchedTripRequestIds.length === 0 ||
      availableSeats <= matchedTripRequestIds.length
    ) {
      continue;
    }

    const planQuery = await firestore
      .collection('journeyPlans')
      .where('journeyId', '==', journeyDoc.id)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    const planDoc = planQuery.docs[0];
    if (!planDoc) continue;
    const planData = planDoc.data();
    const stops = Array.isArray(planData.stops) ? (planData.stops as StopEntry[]) : [];
    if (
      !isNumber(planData.totalDistanceMeters) ||
      !isNumber(planData.totalDurationSeconds) ||
      !isNumber(planData.version)
    ) {
      continue;
    }

    const requestIds = matchedTripRequestIds.filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    const tripSnaps = await Promise.all(
      requestIds.map((id) => firestore.collection('tripRequests').doc(id).get()),
    );
    const existingPassengers = new Map<string, ExistingPassenger>();
    let readable = true;
    for (const snap of tripSnaps) {
      const tripData = snap.data();
      const tripOrigin = pointOf(tripData?.origin);
      const tripDestination = pointOf(tripData?.destination);
      const preferences = tripData?.passengerPreferences as
        | {
            maxExtraTime?: unknown;
            maxDetourDistance?: unknown;
            allowSharedRide?: unknown;
            allowRouteChange?: unknown;
          }
        | undefined;
      const arrivalDeadline: unknown = tripData?.arrivalDeadline;
      const passengerId: unknown = tripData?.passengerId;
      if (
        !tripData ||
        !tripOrigin ||
        !tripDestination ||
        typeof passengerId !== 'string' ||
        !passengerId ||
        !isNumber(tripData.estimatedDistance) ||
        !isNumber(tripData.estimatedDuration) ||
        typeof preferences?.maxExtraTime !== 'number' ||
        typeof preferences?.maxDetourDistance !== 'number' ||
        typeof preferences?.allowSharedRide !== 'boolean' ||
        typeof preferences?.allowRouteChange !== 'boolean'
      ) {
        readable = false;
        break;
      }
      existingPassengers.set(snap.id, {
        id: snap.id,
        passengerId,
        origin: tripOrigin,
        destination: tripDestination,
        estimatedDistanceMeters: tripData.estimatedDistance,
        estimatedDurationSeconds: tripData.estimatedDuration,
        passengerMaxExtraMinutes: preferences.maxExtraTime,
        passengerMaxDetourDistanceKm: preferences.maxDetourDistance,
        allowSharedRide: preferences.allowSharedRide,
        allowRouteChange: preferences.allowRouteChange,
        arrivalDeadlineMs: arrivalDeadline instanceof Timestamp ? arrivalDeadline.toMillis() : null,
      });
    }
    if (!readable) continue;

    plans.push({
      planId: planDoc.id,
      journeyId: journeyDoc.id,
      driverId: data.driverId,
      origin,
      destination,
      availableSeats,
      maxDetourMinutes,
      maxDetourDistanceKm: maxDetourDistance,
      totalDistanceMeters: planData.totalDistanceMeters,
      totalDurationSeconds: planData.totalDurationSeconds,
      version: planData.version,
      stops,
      existingPassengers,
    });
  }
  return plans;
}

interface FeasibleInsertion {
  plan: MatchingJourneyPlan;
  stops: StopEntry[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  addedDistanceMeters: number;
  /** Module 8.6 (traffic delay): route.legs, aligned with [origin, ...stops, destination]. */
  legs: PlanLeg[];
}

/**
 * Tries every insertion position of `request`'s own pickup/dropoff into `plan`'s current stop order,
 * one road-route call each (sequential, never Promise.all - the shared route rate limit is meant for
 * spacing consecutive calls, not refereeing concurrent ones; see Module 5.4's own note on this).
 * Returns the cheapest one that leaves every affected passenger, and the driver, within their own
 * detour limits, or null when none does.
 */
async function bestInsertionInto(
  deps: {
    firestore: Firestore;
    provider: RoutingProvider;
    limits?: LookupLimits;
    now?: () => number;
  },
  plan: MatchingJourneyPlan,
  request: InsertableTrip,
): Promise<FeasibleInsertion | null> {
  const now = (deps.now ?? Date.now)();
  const routeDeps = {
    firestore: deps.firestore,
    provider: deps.provider,
    ...(deps.limits ? { limits: deps.limits } : {}),
  };
  const driverCaller = { uid: plan.driverId, role: 'DRIVER', emailVerified: true };

  const pickupStop: StopEntry = { kind: 'pickup', requestId: request.id };
  const dropoffStop: StopEntry = { kind: 'dropoff', requestId: request.id };
  const passengers = new Map(plan.existingPassengers);
  passengers.set(request.id, {
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
  });

  let best: FeasibleInsertion | null = null;

  for (const candidateStops of insertionCandidates(plan.stops, pickupStop, dropoffStop)) {
    const points = candidateStops.map((stop) => stopPoint(stop, passengers));
    if (points.some((point) => point === null)) continue;
    const fullStops = [plan.origin, ...(points as RoutePoint[]), plan.destination];

    const result = await calculateRoute(routeDeps, driverCaller, { stops: fullStops });
    if (result.status !== 'found' || !result.route) continue;
    const { route } = result;

    const addedDistanceMeters = Math.max(0, route.distanceMeters - plan.totalDistanceMeters);
    const addedDurationSeconds = Math.max(0, route.durationSeconds - plan.totalDurationSeconds);
    if (
      addedDistanceMeters / 1000 > plan.maxDetourDistanceKm ||
      addedDurationSeconds / 60 > plan.maxDetourMinutes
    ) {
      continue;
    }

    // Every passenger whose own pickup and dropoff both appear in this candidate (always true here -
    // nobody is ever removed) must still fit their own limits, not only the newly inserted one.
    let everyoneFits = true;
    for (const passenger of passengers.values()) {
      const pickupIndex = candidateStops.findIndex(
        (stop) => stop.kind === 'pickup' && stop.requestId === passenger.id,
      );
      const dropoffIndex = candidateStops.findIndex(
        (stop) => stop.kind === 'dropoff' && stop.requestId === passenger.id,
      );
      if (pickupIndex === -1 || dropoffIndex === -1) {
        everyoneFits = false;
        break;
      }
      // fullStops[0] is the driver's own origin, so a stop at candidateStops[i] is fullStops[i + 1];
      // route.legs[i] is the leg from fullStops[i] to fullStops[i + 1].
      let ownDistance = 0;
      let ownDuration = 0;
      for (let leg = pickupIndex + 1; leg <= dropoffIndex; leg += 1) {
        ownDistance += route.legs[leg]?.distanceMeters ?? 0;
        ownDuration += route.legs[leg]?.durationSeconds ?? 0;
      }
      const ownAddedDistanceKm =
        Math.max(0, ownDistance - passenger.estimatedDistanceMeters) / 1000;
      const ownAddedMinutes = Math.max(0, ownDuration - passenger.estimatedDurationSeconds) / 60;
      if (
        ownAddedDistanceKm > passenger.passengerMaxDetourDistanceKm ||
        ownAddedMinutes > passenger.passengerMaxExtraMinutes
      ) {
        everyoneFits = false;
        break;
      }

      // Module 8.8 (passenger constraint validation): the request being inserted is never itself a
      // "route change" (its first ever match - see passengerConstraints.ts's own note); an EXISTING
      // passenger's own route changed if their own stop position moved from where it was in the plan
      // being superseded.
      const isNewRequest = passenger.id === request.id;
      const routeChangedForThem =
        !isNewRequest &&
        (pickupIndex !==
          plan.stops.findIndex((s) => s.kind === 'pickup' && s.requestId === passenger.id) ||
          dropoffIndex !==
            plan.stops.findIndex((s) => s.kind === 'dropoff' && s.requestId === passenger.id));
      const expectedDropoffAtMs = now + cumulativeSecondsToStop(route.legs, dropoffIndex) * 1000;
      if (
        checkProtectedConstraints(
          {
            allowSharedRide: passenger.allowSharedRide,
            allowRouteChange: passenger.allowRouteChange,
            arrivalDeadlineMs: passenger.arrivalDeadlineMs,
          },
          { shared: true, routeChangedForThem, expectedDropoffAtMs },
        ) !== null
      ) {
        everyoneFits = false;
        break;
      }
    }
    if (!everyoneFits) continue;

    if (best === null || addedDistanceMeters < best.addedDistanceMeters) {
      best = {
        plan,
        stops: candidateStops,
        totalDistanceMeters: route.distanceMeters,
        totalDurationSeconds: route.durationSeconds,
        addedDistanceMeters,
        legs: route.legs.map((leg) => ({
          distanceMeters: leg.distanceMeters,
          durationSeconds: leg.durationSeconds,
        })),
      };
    }
  }

  return best;
}

export type InsertionOutcome = 'inserted' | 'unmatched';

/**
 * Tries to fit `request` into the best-fitting nearby MATCHING journey with room (proximity/direction
 * Stage 1, same as Module 5.2's own findCandidateJourneys, then a full insertion check - see
 * bestInsertionInto - for the closest INSERTION_CANDIDATES_CHECKED). On success, writes a new plan
 * version and updates the journey and every affected trip request in one transaction, re-checking
 * that nothing has moved on since the search started (the pool may have changed, same reasoning as
 * Module 6.9's own assignment transaction); a race lost this way is reported 'unmatched', same as
 * finding no feasible insertion at all - there is no retry within this same call.
 */
export async function tryInsertIntoMatchingJourney(
  deps: {
    firestore: Firestore;
    provider: RoutingProvider;
    push: PushProvider;
    limits?: LookupLimits;
    now?: () => number;
  },
  request: InsertableTrip,
): Promise<InsertionOutcome> {
  const { firestore } = deps;
  const plans = await readMatchingJourneyPlans(firestore);
  if (plans.length === 0) return 'unmatched';

  const sourceJourneys: CandidateSourceJourney[] = plans.map((plan) => ({
    id: plan.journeyId,
    driverId: plan.driverId,
    origin: plan.origin,
    destination: plan.destination,
    availableSeats: plan.availableSeats,
  }));
  const candidates = findCandidateJourneys(request, sourceJourneys).slice(
    0,
    INSERTION_CANDIDATES_CHECKED,
  );
  if (candidates.length === 0) return 'unmatched';

  const plansById = new Map(plans.map((plan) => [plan.journeyId, plan]));

  let chosen: FeasibleInsertion | null = null;
  for (const candidate of candidates) {
    const plan = plansById.get(candidate.journeyId);
    if (!plan) continue;
    const insertion = await bestInsertionInto(deps, plan, request);
    if (insertion && (!chosen || insertion.addedDistanceMeters < chosen.addedDistanceMeters)) {
      chosen = insertion;
    }
  }
  if (!chosen) return 'unmatched';

  const { plan } = chosen;
  const journeyRef = firestore.collection('driverJourneys').doc(plan.journeyId);
  const oldPlanRef = firestore.collection('journeyPlans').doc(plan.planId);
  const newPlanRef = firestore.collection('journeyPlans').doc();
  const newTripRef = firestore.collection('tripRequests').doc(request.id);
  const existingTripRefs = [...plan.existingPassengers.keys()].map((id) =>
    firestore.collection('tripRequests').doc(id),
  );
  const driverUserRef = firestore.collection('users').doc(plan.driverId);
  const vehicleRef = firestore.collection('vehicles').doc(plan.driverId);
  const pendingPushes: PendingPush[] = [];

  const applied = await firestore.runTransaction(async (tx) => {
    const [journeySnap, oldPlanSnap, newTripSnap, existingTripSnaps, driverUserSnap, vehicleSnap] =
      await Promise.all([
        tx.get(journeyRef),
        tx.get(oldPlanRef),
        tx.get(newTripRef),
        Promise.all(existingTripRefs.map((ref) => tx.get(ref))),
        tx.get(driverUserRef),
        tx.get(vehicleRef),
      ]);
    if (!journeySnap.exists || journeySnap.get('status') !== 'MATCHING') return false;
    if (!oldPlanSnap.exists || oldPlanSnap.get('version') !== plan.version) return false;
    if (!newTripSnap.exists || newTripSnap.get('status') !== 'SEARCHING') return false;
    for (const snap of existingTripSnaps) {
      if (!snap.exists || snap.get('assignedPlanId') !== plan.planId) return false;
    }

    const driverName = firstNameOf(driverUserSnap.get('name'), 'Driver');
    const vehicleType = (vehicleSnap.get('type') as string | undefined) ?? null;
    const vehicleMake = (vehicleSnap.get('make') as string | undefined) ?? null;
    const vehicleModel = (vehicleSnap.get('model') as string | undefined) ?? null;
    const vehiclePlateNumber = (vehicleSnap.get('plateNumber') as string | undefined) ?? null;
    const requestIds = [...plan.existingPassengers.keys(), request.id];

    tx.set(newPlanRef, {
      journeyId: plan.journeyId,
      driverId: plan.driverId,
      requestIds,
      stops: chosen.stops,
      totalDistanceMeters: chosen.totalDistanceMeters,
      totalDurationSeconds: chosen.totalDurationSeconds,
      legs: chosen.legs,
      version: plan.version + 1,
      supersedes: plan.planId,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(journeyRef, {
      matchedTripRequestIds: requestIds,
      updatedAt: FieldValue.serverTimestamp(),
    });
    for (const existingRef of existingTripRefs) {
      tx.update(existingRef, {
        assignedPlanId: newPlanRef.id,
        // Module 9.3: insertion always makes this journey shared (it went from one passenger to
        // two-or-more in this very step), for the existing passenger(s) as much as the new one.
        sharedRide: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(newTripRef, {
      status: 'PICKUP_ASSIGNED',
      matchedJourneyId: plan.journeyId,
      matchedDriverId: plan.driverId,
      assignedPlanId: newPlanRef.id,
      driverName,
      vehicleType,
      vehicleMake,
      vehicleModel,
      vehiclePlateNumber,
      sharedRide: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: plan.driverId,
      action: 'TRIP_INSERTED_INTO_JOURNEY',
      entity: `tripRequests/${request.id}`,
      previousState: { status: 'SEARCHING' },
      newState: { status: 'PICKUP_ASSIGNED', matchedJourneyId: plan.journeyId },
      reason: `Inserted into an already-matched journey's plan (version ${plan.version + 1})`,
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: plan.driverId,
      action: 'PLAN_REVISED',
      entity: `driverJourneys/${plan.journeyId}`,
      previousState: { planId: plan.planId, version: plan.version },
      newState: { planId: newPlanRef.id, version: plan.version + 1 },
      reason: 'A new passenger was inserted into the existing route',
    });

    // Module 8.9 (notification): the new passenger and every existing one on this journey, each with
    // their own reason - see notifications.ts's own file-level note.
    createNotification(tx, firestore, {
      recipientId: request.passengerId,
      type: 'MATCHED_INTO_SHARED_RIDE',
      message: 'You have been matched with a driver.',
      relatedEntity: `tripRequests/${request.id}`,
    });
    for (const passenger of plan.existingPassengers.values()) {
      notifyWithPush(
        tx,
        firestore,
        {
          recipientId: passenger.passengerId,
          type: 'ROUTE_ADJUSTED_FOR_NEW_PASSENGER',
          message: "Your driver's route was adjusted to pick up another passenger.",
          relatedEntity: `tripRequests/${passenger.id}`,
        },
        'Route updated',
        pendingPushes,
      );
    }
    return true;
  });

  if (applied) {
    // Module 10.3 (trip matched push): sent AFTER the transaction above commits (a network call,
    // never inside a Firestore transaction) - the driver gets exactly one push here, since insertion
    // only ever adds one passenger at a time (unlike module 6.9's own batch match, which can pool
    // several). sendPushToUser never throws and no-ops for anyone with no saved token.
    await Promise.all([
      sendPushToUser(deps, plan.driverId, {
        title: 'New passenger',
        body: 'A new passenger has been matched to your journey.',
      }),
      sendPushToUser(deps, request.passengerId, {
        title: 'Trip matched',
        body: "You've been matched with a driver.",
      }),
      // Module 10.7 (route changes push): every existing passenger whose plan changed to fit the new
      // one in, queued above via notifyWithPush.
      sendQueuedPushes(deps, pendingPushes),
    ]);
  }

  return applied ? 'inserted' : 'unmatched';
}
