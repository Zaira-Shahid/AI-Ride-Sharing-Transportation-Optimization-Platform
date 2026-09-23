import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { requireVerifiedDriver, type DriverCaller } from './callers.js';
import { canTransition } from './tripRequests.js';

// Module 7.2 (trip execution, Phase 7): advances a matched request one step at a time, through two
// driver actions on the matched driver's own request (Module 7.1's Firestore rules already let them
// read it) - headToPickup (PICKUP_ASSIGNED -> DRIVER_ARRIVING) and confirmPickup (DRIVER_ARRIVING ->
// PICKED_UP). Both manual (user decision, this session): no GPS-based inference. A request the driver
// does not own, or that does not exist, is reported as not found (same non-leaking pattern as
// cancelTripRequest); one already at the target status is left as it is (idempotent retry).
//
// KNOWN GAP, flagged rather than silently decided: for a multi-passenger plan (Module 6.9), nothing
// here enforces the plan's own stop order - the driver can call these for any of their own matched
// requests in any order, not just the next stop in journeyPlans. Enforcing order needs reading the
// plan and knowing which stops are already done, which is more than either of this module's two
// questions asked about; left for a later module if it turns out to matter in practice.
//
// The journey's own status (MATCHING) is untouched by either step - whether/when it becomes ACTIVE
// once a passenger is actually picked up is also not decided here, for the same reason.

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

    tx.update(tripRef, { status: to, updatedAt: FieldValue.serverTimestamp() });
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
  );
}

/** The driver confirms the passenger is now in the vehicle. Manual (user decision, this session). */
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
  );
}
