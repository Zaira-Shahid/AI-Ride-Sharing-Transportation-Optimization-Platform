import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { enforceCallRateLimit } from './callLimits.js';
import { requireVerifiedDriver, type DriverCaller } from './callers.js';
import type { LookupLimits } from './lookupLimits.js';
import { buildJourneyStopMatrix } from './matching.js';
import { notifyWithPush, sendQueuedPushes, type PendingPush } from './notifications.js';
import type { JourneyPlanBody, RouteMatrixLegBody } from './optimizationClient.js';
import { legsForPlanPath } from './optimizationRun.js';
import type { PushProvider } from './pushProvider.js';
import type { RoutePoint, RoutingProvider } from './routing.js';
import { isCompanyRide, tenantOf } from './tenant.js';

// A company driver's say over a match (module A3b, docs/a3b-driver-decline-design.md).
//
// A company match stands unless the driver declines inside the window (silence confirms): the match
// stays PICKUP_ASSIGNED and carries a `driverDecision` with a deadline, which only company rides ever
// have. No new ride state, no timer. A decline releases that one rider (as route re-ordering does when
// it drops a request), revises the plan without their stops, returns the journey to AVAILABLE if no
// rider is left, and remembers the journey in the rider's `declinedJourneyIds` so they are never offered
// to the same driver again. Starting the pickup (tripExecution) also confirms.

const HOUR_MS = 3_600_000;
const DECISION_LIMIT = { windowMs: HOUR_MS, maxCalls: 60 };

const tripIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,128}$/);
export const declineMatchedRiderInputSchema = z.object({ tripId: tripIdSchema });
export const confirmMatchedRiderInputSchema = z.object({ tripId: tripIdSchema });

const NOT_FOUND = 'That ride request was not found.';

interface StoredStop {
  kind: 'pickup' | 'dropoff';
  requestId: string;
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function pointOf(value: unknown): RoutePoint | null {
  if (typeof value !== 'object' || value === null) return null;
  const { latitude, longitude } = value as Record<string, unknown>;
  return isNumber(latitude) && isNumber(longitude) ? { latitude, longitude } : null;
}

function nowOf(deps: { now?: () => number }): number {
  return (deps.now ?? Date.now)();
}

function decisionOf(trip: DocumentSnapshot): { status: unknown; deadlineMs: number | null } | null {
  const decision: unknown = trip.get('driverDecision');
  if (typeof decision !== 'object' || decision === null) return null;
  const { status, deadline } = decision as { status?: unknown; deadline?: unknown };
  return { status, deadlineMs: deadline instanceof Timestamp ? deadline.toMillis() : null };
}

/**
 * The calling driver's own company ride, or a "not found" that is the same whether it does not exist,
 * is someone else's, belongs to no company or belongs to another company.
 */
function requireOwnCompanyRide(trip: DocumentSnapshot, caller: DriverCaller): void {
  if (
    !trip.exists ||
    !isCompanyRide(trip.data()) ||
    tenantOf(trip.data()) !== caller.companyId ||
    trip.get('matchedDriverId') !== caller.uid
  ) {
    throw new HttpsError('not-found', NOT_FOUND);
  }
}

// ---------------------------------------------------------------------------------------------
// Confirm

/**
 * The driver accepts a company match early, which ends the window so the rider can rely on it. Safe to
 * repeat, and harmless once the window has passed or the pickup has begun.
 */
export async function confirmMatchedRider(
  deps: { firestore: Firestore; now?: () => number },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<{ status: 'confirmed' | 'unchanged' }> {
  requireVerifiedDriver(caller);
  const { firestore } = deps;
  await enforceCallRateLimit(
    firestore,
    'confirmMatchedRider',
    caller.uid,
    nowOf(deps),
    DECISION_LIMIT,
  );
  const parsed = confirmMatchedRiderInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'That request is not valid.');
  const tripRef = firestore.doc(`tripRequests/${parsed.data.tripId}`);

  return firestore.runTransaction(async (tx): Promise<{ status: 'confirmed' | 'unchanged' }> => {
    const trip = await tx.get(tripRef);
    requireOwnCompanyRide(trip, caller);
    const decision = decisionOf(trip);
    if (trip.get('status') !== 'PICKUP_ASSIGNED' || decision?.status !== 'OPEN') {
      return { status: 'unchanged' };
    }
    tx.update(tripRef, {
      'driverDecision.status': 'CONFIRMED',
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: 'TRIP_CONFIRMED_BY_DRIVER',
      entity: `tripRequests/${tripRef.id}`,
      previousState: { driverDecision: 'OPEN' },
      newState: { driverDecision: 'CONFIRMED' },
      reason: 'The driver accepted the match before the window closed',
    });
    return { status: 'confirmed' };
  });
}

// ---------------------------------------------------------------------------------------------
// Decline

export interface DeclineDeps {
  firestore: Firestore;
  provider: RoutingProvider;
  push: PushProvider;
  limits?: LookupLimits;
  now?: () => number;
}

const toStops = (value: unknown): StoredStop[] =>
  Array.isArray(value)
    ? (value as unknown[]).flatMap((stop) => {
        const { kind, requestId } = (stop ?? {}) as Record<string, unknown>;
        return (kind === 'pickup' || kind === 'dropoff') && typeof requestId === 'string'
          ? [{ kind, requestId }]
          : [];
      })
    : [];

/**
 * The driver declines one company rider inside the window. Everyone else on the journey keeps their
 * place on a revised plan. Refused, with nothing written, once the window has closed, once the pickup
 * has begun, or for a ride that is not this driver's. A repeat answers "unchanged".
 */
export async function declineMatchedRider(
  deps: DeclineDeps,
  caller: DriverCaller,
  rawInput: unknown,
): Promise<{ status: 'declined' | 'unchanged' }> {
  requireVerifiedDriver(caller);
  const { firestore } = deps;
  const now = nowOf(deps);
  await enforceCallRateLimit(firestore, 'declineMatchedRider', caller.uid, now, DECISION_LIMIT);
  const parsed = declineMatchedRiderInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'That request is not valid.');
  const tripId = parsed.data.tripId;
  const tripRef = firestore.doc(`tripRequests/${tripId}`);

  const trip = await tripRef.get();
  // A repeat: the ride is no longer this driver's, but this driver's journey is on its declined list.
  if (
    trip.exists &&
    isCompanyRide(trip.data()) &&
    tenantOf(trip.data()) === caller.companyId &&
    trip.get('matchedDriverId') !== caller.uid
  ) {
    const driver = await firestore.doc(`drivers/${caller.uid}`).get();
    const journeyId: unknown = driver.get('currentJourneyId');
    const declined: unknown = trip.get('declinedJourneyIds');
    if (typeof journeyId === 'string' && Array.isArray(declined) && declined.includes(journeyId)) {
      return { status: 'unchanged' };
    }
  }
  requireOwnCompanyRide(trip, caller);
  assertOpen(trip, now);

  const journeyId = trip.get('matchedJourneyId') as string;
  const planId = trip.get('assignedPlanId') as string;
  const journeyRef = firestore.doc(`driverJourneys/${journeyId}`);
  const planRef = firestore.doc(`journeyPlans/${planId}`);
  const [journey, plan] = await Promise.all([journeyRef.get(), planRef.get()]);
  if (!journey.exists || journey.get('driverId') !== caller.uid || !plan.exists) {
    throw new HttpsError('failed-precondition', 'This ride cannot be declined right now.');
  }

  // The plan without this rider, and its legs, worked out before the transaction as insertion does.
  const oldStops = toStops(plan.get('stops'));
  const remainingIds = oldStops
    .filter((stop) => stop.kind === 'pickup' && stop.requestId !== tripId)
    .map((stop) => stop.requestId);
  const newStops = oldStops.filter((stop) => stop.requestId !== tripId);
  let legs: ReturnType<typeof legsForPlanPath> = null;
  let totalDistanceMeters: unknown = plan.get('totalDistanceMeters');
  let totalDurationSeconds: unknown = plan.get('totalDurationSeconds');
  if (remainingIds.length > 0) {
    const remaining = await Promise.all(
      remainingIds.map((id) => firestore.doc(`tripRequests/${id}`).get()),
    );
    const origin = pointOf(journey.get('origin'));
    const destination = pointOf(journey.get('destination'));
    const requests = remaining.flatMap((snap) => {
      const pickup = pointOf(snap.get('origin'));
      const dropoff = pointOf(snap.get('destination'));
      return pickup && dropoff ? [{ requestId: snap.id, pickup, destination: dropoff }] : [];
    });
    if (origin && destination && requests.length === remainingIds.length) {
      const matrix = await buildJourneyStopMatrix(
        {
          firestore,
          provider: deps.provider,
          ...(deps.limits ? { limits: deps.limits } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        },
        { driverId: caller.uid, driverOrigin: origin, driverDestination: destination, requests },
      );
      if (matrix.status === 'computed') {
        const matrixLegs: RouteMatrixLegBody[] = matrix.legs.map((leg) => ({
          from_stop: leg.fromStop,
          to_stop: leg.toStop,
          distance_meters: leg.distanceMeters,
          duration_seconds: leg.durationSeconds,
        }));
        const bodyStops: JourneyPlanBody['stops'] = newStops.map((stop) => ({
          kind: stop.kind,
          request_id: stop.requestId,
        }));
        legs = legsForPlanPath(matrixLegs, bodyStops);
        if (legs) {
          totalDistanceMeters = legs.reduce((sum, leg) => sum + leg.distanceMeters, 0);
          totalDurationSeconds = legs.reduce((sum, leg) => sum + leg.durationSeconds, 0);
        }
      }
    }
  }

  const newPlanRef = firestore.collection('journeyPlans').doc();
  const remainingRefs = remainingIds.map((id) => firestore.doc(`tripRequests/${id}`));
  const pending: PendingPush[] = [];

  await firestore.runTransaction(async (tx) => {
    const [freshTrip, freshJourney, freshPlan, ...freshRemaining] = await Promise.all([
      tx.get(tripRef),
      tx.get(journeyRef),
      tx.get(planRef),
      ...remainingRefs.map((ref) => tx.get(ref)),
    ]);
    requireOwnCompanyRide(freshTrip, caller);
    assertOpen(freshTrip, now);
    if (
      !freshJourney.exists ||
      freshJourney.get('status') !== 'MATCHING' ||
      !freshPlan.exists ||
      freshPlan.get('version') !== plan.get('version') ||
      freshTrip.get('assignedPlanId') !== planId ||
      freshRemaining.some((snap) => !snap.exists || snap.get('assignedPlanId') !== planId)
    ) {
      throw new HttpsError('failed-precondition', 'Something changed on this journey. Try again.');
    }

    // The rider goes back to searching, and this journey is never offered to them again.
    tx.update(tripRef, {
      status: 'SEARCHING',
      matchedJourneyId: null,
      matchedDriverId: null,
      driverName: null,
      vehicleType: null,
      vehicleMake: null,
      vehicleModel: null,
      vehiclePlateNumber: null,
      driverLocation: null,
      assignedPlanId: null,
      driverDecision: FieldValue.delete(),
      declinedJourneyIds: FieldValue.arrayUnion(journeyId),
      declineCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: 'TRIP_DECLINED_BY_DRIVER',
      entity: `tripRequests/${tripId}`,
      previousState: { status: 'PICKUP_ASSIGNED' },
      newState: { status: 'SEARCHING' },
      reason: 'The driver declined the ride inside the decline window',
    });
    const passengerId: unknown = freshTrip.get('passengerId');
    if (typeof passengerId === 'string' && passengerId) {
      notifyWithPush(
        tx,
        firestore,
        {
          recipientId: passengerId,
          type: 'RELEASED_TO_SEARCHING',
          message: 'Your driver cannot take this ride. We are looking for a new match for you.',
          relatedEntity: `tripRequests/${tripId}`,
        },
        'Finding a new driver',
        pending,
      );
    }

    if (remainingIds.length > 0) {
      // Everyone else keeps their place, on a new plan version without this rider's stops.
      tx.set(newPlanRef, {
        journeyId,
        driverId: caller.uid,
        requestIds: remainingIds,
        stops: newStops,
        totalDistanceMeters,
        totalDurationSeconds,
        legs,
        version: (plan.get('version') as number) + 1,
        supersedes: planId,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.update(journeyRef, {
        matchedTripRequestIds: remainingIds,
        updatedAt: FieldValue.serverTimestamp(),
      });
      for (const ref of remainingRefs) {
        tx.update(ref, { assignedPlanId: newPlanRef.id, updatedAt: FieldValue.serverTimestamp() });
      }
    } else {
      // Nobody left: the journey is open for matching again, the driver still online.
      tx.update(journeyRef, {
        status: 'AVAILABLE',
        matchedTripRequestIds: [],
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });

  await sendQueuedPushes(deps, pending);
  return { status: 'declined' };
}

/** The ride is still only assigned, and the driver may still decline: inside the window, not confirmed. */
function assertOpen(trip: DocumentSnapshot, now: number): void {
  if (trip.get('status') !== 'PICKUP_ASSIGNED') {
    throw new HttpsError('failed-precondition', 'This ride is already under way.');
  }
  const decision = decisionOf(trip);
  if (decision?.status !== 'OPEN' || decision.deadlineMs === null || now >= decision.deadlineMs) {
    throw new HttpsError('failed-precondition', 'The time to decline this ride has passed.');
  }
}
