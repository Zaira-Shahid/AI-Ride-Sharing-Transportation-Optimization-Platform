import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { requireVerifiedDriver, type DriverCaller } from './callers.js';
import { canTransition } from './tripRequests.js';

// Module 7.2 (trip execution, Phase 7): advances a matched request one step at a time, through
// driver actions on the matched driver's own request (Module 7.1's Firestore rules already let them
// read it) - headToPickup (PICKUP_ASSIGNED -> DRIVER_ARRIVING), confirmPickup (DRIVER_ARRIVING ->
// PICKED_UP), and startTransit (PICKED_UP -> IN_TRANSIT, Module 7.4). All manual (user decision):
// no GPS-based inference. A request the driver does not own, or that does not exist, is reported as
// not found (same non-leaking pattern as cancelTripRequest); one already at the target status is
// left as it is (idempotent retry).
//
// Module 7.4 closes 7.2's own stop-order gap, but only for the two PICKUP actions: headToPickup and
// confirmPickup for a given request are refused (WRONG_STATUS, same as any other precondition
// failure - the app itself only ever shows a button for the earliest pending pickup, so a real driver
// never sees this) unless every PICKUP stop earlier in the plan's own order is already at PICKED_UP
// or later. startTransit is NOT order-gated: it only ever moves a passenger who is already PICKED_UP
// to IN_TRANSIT, which cannot skip past anyone still waiting - there is nothing left for it to jump
// ahead of. A future DROPOFF action will need its own ordering against both kinds of stop; this one
// only looks at 'pickup' stops.
//
// The journey's own status becomes ACTIVE (from MATCHING) the moment its first passenger is
// confirmed picked up (user decision); left alone on every confirmPickup after that (already ACTIVE).

interface PlanStopEntry {
  kind: 'pickup' | 'dropoff';
  requestId: string;
}

function parsePlanStops(raw: unknown): PlanStopEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: unknown): PlanStopEntry | null => {
      if (typeof entry !== 'object' || entry === null) return null;
      const { kind, requestId } = entry as Record<string, unknown>;
      return (kind === 'pickup' || kind === 'dropoff') && typeof requestId === 'string'
        ? { kind, requestId }
        : null;
    })
    .filter((entry): entry is PlanStopEntry => entry !== null);
}

const PICKED_UP_OR_LATER = new Set(['PICKED_UP', 'IN_TRANSIT', 'DROPOFF_APPROACHING', 'COMPLETED']);

/**
 * Whether every PICKUP stop before `tripId`'s own one in its plan is already PICKED_UP or later. True
 * (nothing to block on) when the request has no plan, the plan cannot be read, or it is the earliest
 * pickup - reading a plan is a defensive check on top of the app's own ordering, not the only guard.
 */
async function earlierPickupsDone(
  tx: Transaction,
  firestore: Firestore,
  tripId: string,
  assignedPlanId: unknown,
): Promise<boolean> {
  if (typeof assignedPlanId !== 'string' || !assignedPlanId) return true;
  const planSnap = await tx.get(firestore.collection('journeyPlans').doc(assignedPlanId));
  if (!planSnap.exists) return true;

  const pickupStops = parsePlanStops(planSnap.get('stops')).filter((s) => s.kind === 'pickup');
  const index = pickupStops.findIndex((s) => s.requestId === tripId);
  if (index <= 0) return true;

  const earlierIds = pickupStops.slice(0, index).map((s) => s.requestId);
  const earlierSnaps = await Promise.all(
    earlierIds.map((id) => tx.get(firestore.collection('tripRequests').doc(id))),
  );
  return earlierSnaps.every((snap) => PICKED_UP_OR_LATER.has(snap.get('status') as string));
}

// Mirrors trip-request.ts in @ridemesh/types; tests/roles-parity.test.ts fails if they diverge.
export const TRIP_EXECUTION_REFUSALS = ['INVALID', 'NOT_FOUND', 'WRONG_STATUS'] as const;
export type TripExecutionRefusal = (typeof TRIP_EXECUTION_REFUSALS)[number];

export const advanceTripInputSchema = z.object({ tripId: z.string().min(1).max(200) });
export type AdvanceTripInput = z.infer<typeof advanceTripInputSchema>;
export interface AdvanceTripResult {
  status: 'updated' | 'unchanged';
}

function refuse(
  code: FunctionsErrorCode,
  reason: TripExecutionRefusal,
  message: string,
): HttpsError {
  return new HttpsError(code, message, { reason });
}

async function advance(
  deps: { firestore: Firestore },
  caller: DriverCaller,
  rawInput: unknown,
  from: string,
  to: string,
  action: string,
  reason: string,
  options: { checkPickupOrder?: boolean; activateJourney?: boolean } = {},
): Promise<AdvanceTripResult> {
  requireVerifiedDriver(caller);

  const parsed = advanceTripInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw refuse('invalid-argument', 'INVALID', 'That request is not valid.');
  }
  const { tripId } = parsed.data;
  if (tripId.includes('/')) {
    throw refuse('invalid-argument', 'INVALID', 'That request is not valid.');
  }

  const { firestore } = deps;
  const tripRef = firestore.collection('tripRequests').doc(tripId);

  return firestore.runTransaction(async (tx): Promise<AdvanceTripResult> => {
    const trip = await tx.get(tripRef);
    if (!trip.exists || trip.get('matchedDriverId') !== caller.uid) {
      throw refuse('not-found', 'NOT_FOUND', 'That ride request was not found.');
    }

    const status: unknown = trip.get('status');
    if (status === to) return { status: 'unchanged' };
    if (status !== from || !canTransition(status, to)) {
      throw refuse('failed-precondition', 'WRONG_STATUS', 'This step cannot be done right now.');
    }

    if (options.checkPickupOrder) {
      const ok = await earlierPickupsDone(tx, firestore, tripId, trip.get('assignedPlanId'));
      if (!ok) {
        throw refuse('failed-precondition', 'WRONG_STATUS', 'This step cannot be done right now.');
      }
    }

    let journeyRef = null;
    if (options.activateJourney) {
      const journeyId = trip.get('matchedJourneyId');
      if (typeof journeyId === 'string' && journeyId) {
        journeyRef = firestore.collection('driverJourneys').doc(journeyId);
        const journey = await tx.get(journeyRef);
        if (!journey.exists || journey.get('status') !== 'MATCHING') journeyRef = null;
      }
    }

    tx.update(tripRef, { status: to, updatedAt: FieldValue.serverTimestamp() });
    if (journeyRef) {
      tx.update(journeyRef, { status: 'ACTIVE', updatedAt: FieldValue.serverTimestamp() });
    }
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action,
      entity: `tripRequests/${tripId}`,
      previousState: { status },
      newState: { status: to },
      reason,
    });
    return { status: 'updated' };
  });
}

/** The driver starts toward the passenger's pickup point. Manual (user decision, this session). */
export function headToPickup(
  deps: { firestore: Firestore },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<AdvanceTripResult> {
  return advance(
    deps,
    caller,
    rawInput,
    'PICKUP_ASSIGNED',
    'DRIVER_ARRIVING',
    'TRIP_DRIVER_ARRIVING',
    'Driver headed to pickup',
    { checkPickupOrder: true },
  );
}

/**
 * The driver confirms the passenger is now in the vehicle. Manual (user decision, this session).
 * Also moves the journey MATCHING -> ACTIVE if this is its first confirmed pickup (Module 7.4).
 */
export function confirmPickup(
  deps: { firestore: Firestore },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<AdvanceTripResult> {
  return advance(
    deps,
    caller,
    rawInput,
    'DRIVER_ARRIVING',
    'PICKED_UP',
    'TRIP_PICKED_UP',
    'Driver confirmed pickup',
    { checkPickupOrder: true, activateJourney: true },
  );
}

/**
 * The driver confirms they are now driving with this passenger aboard (Module 7.4). Never blocked by
 * plan order: a passenger already PICKED_UP cannot be jumping ahead of anyone still waiting.
 */
export function startTransit(
  deps: { firestore: Firestore },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<AdvanceTripResult> {
  return advance(
    deps,
    caller,
    rawInput,
    'PICKED_UP',
    'IN_TRANSIT',
    'TRIP_IN_TRANSIT',
    'Driver started the trip',
  );
}
