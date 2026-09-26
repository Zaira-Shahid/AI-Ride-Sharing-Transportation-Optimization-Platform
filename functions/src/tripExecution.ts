import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { requireVerifiedDriver, type DriverCaller } from './callers.js';
import { computeFinalFareMinorUnits, computePlatformFeeMinorUnits } from './fare.js';
import { readFareConfig } from './fareConfig.js';
import { canTransition } from './tripRequests.js';

// Module 7.2 (trip execution, Phase 7): advances a matched request one step at a time, through
// driver actions on the matched driver's own request (Module 7.1's Firestore rules already let them
// read it) - headToPickup (PICKUP_ASSIGNED -> DRIVER_ARRIVING), confirmPickup (DRIVER_ARRIVING ->
// PICKED_UP), startTransit (PICKED_UP -> IN_TRANSIT, Module 7.4), approachDropoff (IN_TRANSIT ->
// DROPOFF_APPROACHING, Module 7.5) and completeDropoff (DROPOFF_APPROACHING -> COMPLETED, Module
// 7.5). All manual (user decision): no GPS-based inference. A request the driver does not own, or
// that does not exist, is reported as not found (same non-leaking pattern as cancelTripRequest); one
// already at the target status is left as it is (idempotent retry).
//
// Stop-order enforcement (Module 7.4, widened in 7.5 to cover dropoffs too): headToPickup,
// confirmPickup, approachDropoff and completeDropoff for a given request are refused (WRONG_STATUS,
// same as any other precondition failure - the app itself only ever offers a button for the earliest
// actionable stop, so a real driver never sees this) unless every stop earlier in the plan's own
// order - pickup OR dropoff - is already done: a pickup stop counts as done once its request is
// PICKED_UP or later, a dropoff stop only once its request is COMPLETED. startTransit stays
// unordered (Module 7.4's own reasoning still holds: a passenger already PICKED_UP cannot be jumping
// ahead of anyone still waiting).
//
// The journey's own status becomes ACTIVE (from MATCHING) the moment its first passenger is
// confirmed picked up (Module 7.4); left alone on every confirmPickup after that (already ACTIVE).
// Module 7.5: completeDropoff also clears the passenger's users/{uid}.currentTripRequestId when it
// still points at this request (mirroring cancelTripRequest, so Home returns to "Request ride"
// without the passenger needing to do anything), and moves the JOURNEY MATCHING/ACTIVE -> COMPLETED
// once every one of its matchedTripRequestIds has reached COMPLETED - clearing the driver's own
// drivers/{uid}.currentJourneyId in the same step. That clear matters: declareDestination refuses to
// touch a journey outside DRAFT/AVAILABLE, so without it a driver whose journey just finished could
// never start a new one.

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

function stopIsDone(stop: PlanStopEntry, status: string | undefined): boolean {
  if (status === undefined) return false;
  return stop.kind === 'pickup' ? PICKED_UP_OR_LATER.has(status) : status === 'COMPLETED';
}

/**
 * Whether every stop (pickup or dropoff, of any request) before `tripId`'s own `kind` stop in its
 * plan is already done. True (nothing to block on) when the request has no plan, the plan cannot be
 * read, or its own stop is the earliest one - reading a plan is a defensive check on top of the app's
 * own ordering, not the only guard.
 */
async function earlierStopsDone(
  tx: Transaction,
  firestore: Firestore,
  tripId: string,
  kind: 'pickup' | 'dropoff',
  assignedPlanId: unknown,
): Promise<boolean> {
  if (typeof assignedPlanId !== 'string' || !assignedPlanId) return true;
  const planSnap = await tx.get(firestore.collection('journeyPlans').doc(assignedPlanId));
  if (!planSnap.exists) return true;

  const stops = parsePlanStops(planSnap.get('stops'));
  const index = stops.findIndex((s) => s.kind === kind && s.requestId === tripId);
  if (index <= 0) return true;

  const earlierStops = stops.slice(0, index);
  const ids = [...new Set(earlierStops.map((s) => s.requestId))];
  const snaps = await Promise.all(
    ids.map((id) => tx.get(firestore.collection('tripRequests').doc(id))),
  );
  const statusById = new Map(
    snaps.map((snap) => [snap.id, snap.get('status') as string | undefined]),
  );

  return earlierStops.every((stop) => stopIsDone(stop, statusById.get(stop.requestId)));
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
  options: {
    checkStopOrder?: 'pickup' | 'dropoff';
    activateJourney?: boolean;
    finalizeIfLastDropoff?: boolean;
    finalizeFare?: boolean;
  } = {},
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

  // Module 9.3 (fare calculation): read once, outside the transaction - the config is not
  // transactionally sensitive to this request's own document, the same stance paymentAuthorization.ts
  // already takes reading it before deciding an authorization amount.
  const fareConfig = options.finalizeFare ? await readFareConfig(firestore) : null;

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

    if (options.checkStopOrder) {
      const ok = await earlierStopsDone(
        tx,
        firestore,
        tripId,
        options.checkStopOrder,
        trip.get('assignedPlanId'),
      );
      if (!ok) {
        throw refuse('failed-precondition', 'WRONG_STATUS', 'This step cannot be done right now.');
      }
    }

    let journeyToActivateRef = null;
    if (options.activateJourney) {
      const journeyId = trip.get('matchedJourneyId');
      if (typeof journeyId === 'string' && journeyId) {
        journeyToActivateRef = firestore.collection('driverJourneys').doc(journeyId);
        const journey = await tx.get(journeyToActivateRef);
        if (!journey.exists || journey.get('status') !== 'MATCHING') journeyToActivateRef = null;
      }
    }

    // Module 7.5: on the LAST dropoff of a journey, also complete the journey itself and free the
    // driver to start a new one. Read everything needed for this before any write below.
    let passengerRefToClear = null;
    let journeyToCompleteRef = null;
    let driverRefToFree = null;
    if (options.finalizeIfLastDropoff) {
      const passengerId = trip.get('passengerId');
      if (typeof passengerId === 'string' && passengerId) {
        const candidate = firestore.collection('users').doc(passengerId);
        const passengerUser = await tx.get(candidate);
        if (passengerUser.exists && passengerUser.get('currentTripRequestId') === tripId) {
          passengerRefToClear = candidate;
        }
      }

      const journeyId = trip.get('matchedJourneyId');
      if (typeof journeyId === 'string' && journeyId) {
        const journeyRef = firestore.collection('driverJourneys').doc(journeyId);
        const journey = await tx.get(journeyRef);
        const matchedIds = journey.get('matchedTripRequestIds');
        const siblingIds = (Array.isArray(matchedIds) ? matchedIds : []).filter(
          (id): id is string => typeof id === 'string' && id !== tripId,
        );
        const siblingSnaps = await Promise.all(
          siblingIds.map((id) => tx.get(firestore.collection('tripRequests').doc(id))),
        );
        if (journey.exists && siblingSnaps.every((snap) => snap.get('status') === 'COMPLETED')) {
          journeyToCompleteRef = journeyRef;
          const driverId = journey.get('driverId');
          if (typeof driverId === 'string' && driverId) {
            driverRefToFree = firestore.collection('drivers').doc(driverId);
          }
        }
      }
    }

    let fareFields: { finalFareMinorUnits: number; platformFeeMinorUnits: number } | null = null;
    if (fareConfig) {
      const estimatedDistance = trip.get('estimatedDistance');
      const estimatedDuration = trip.get('estimatedDuration');
      if (typeof estimatedDistance === 'number' && typeof estimatedDuration === 'number') {
        const finalFareMinorUnits = computeFinalFareMinorUnits(
          fareConfig,
          estimatedDistance,
          estimatedDuration,
          trip.get('sharedRide') === true,
        );
        fareFields = {
          finalFareMinorUnits,
          platformFeeMinorUnits: computePlatformFeeMinorUnits(fareConfig, finalFareMinorUnits),
        };
      }
    }

    tx.update(tripRef, {
      status: to,
      ...fareFields,
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (journeyToActivateRef) {
      tx.update(journeyToActivateRef, {
        status: 'ACTIVE',
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    if (passengerRefToClear) {
      tx.update(passengerRefToClear, {
        currentTripRequestId: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    if (journeyToCompleteRef) {
      tx.update(journeyToCompleteRef, {
        status: 'COMPLETED',
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    if (driverRefToFree) {
      tx.update(driverRefToFree, {
        currentJourneyId: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
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
    { checkStopOrder: 'pickup' },
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
    { checkStopOrder: 'pickup', activateJourney: true },
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

/** The driver starts toward the passenger's destination. Manual (user decision, Module 7.5). */
export function approachDropoff(
  deps: { firestore: Firestore },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<AdvanceTripResult> {
  return advance(
    deps,
    caller,
    rawInput,
    'IN_TRANSIT',
    'DROPOFF_APPROACHING',
    'TRIP_DROPOFF_APPROACHING',
    'Driver approaching drop-off',
    { checkStopOrder: 'dropoff' },
  );
}

/**
 * The driver confirms the passenger has been dropped off (Module 7.5). Clears the passenger's own
 * open-request pointer if it still points here, and completes the journey (freeing the driver's own
 * currentJourneyId) once every one of its matched requests has reached COMPLETED. Also computes and
 * stores the passenger's final fare and the platform's own cut of it (Module 9.3) - from the same
 * estimatedDistance/estimatedDuration used throughout, since no real "distance actually traveled" is
 * tracked; skipped (left null) if either is somehow missing.
 */
export function completeDropoff(
  deps: { firestore: Firestore },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<AdvanceTripResult> {
  return advance(
    deps,
    caller,
    rawInput,
    'DROPOFF_APPROACHING',
    'COMPLETED',
    'TRIP_COMPLETED',
    'Driver completed the drop-off',
    { checkStopOrder: 'dropoff', finalizeIfLastDropoff: true, finalizeFare: true },
  );
}
