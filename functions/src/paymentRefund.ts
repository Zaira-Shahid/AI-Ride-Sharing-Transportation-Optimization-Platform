import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { StripeProvider } from './stripeProvider.js';

// Module 9.7 (refunds), second half - refunding an already-CAPTURED payment, full or partial. Unlike
// voidStaleAuthorization (paymentVoid.ts), which reacts to an existing, live-reachable release path,
// there is no real trigger for this yet: no passenger-facing "request a refund" flow and no admin
// dashboard exist (Phase 11, not built). User-approved: build and test the logic now, the same "build
// now, wire it into a real trigger once one exists" stance Module 9.2's own authorizeTripPayment
// already takes - nothing in this file is called from index.ts.
//
// User-decided policy: a refund never adjusts or reverses the driver's own driverEarnings ledger
// entry (Module 9.5) - it comes out of the platform's own margin, not the driver's payout, since the
// driver already completed the trip and a refund decision is outside their control (the standard
// stance in ride-sharing apps; a driver-fault refund would need its own separate policy later, e.g.
// once fraud detection exists). driverEarnings entries are therefore FINAL once written: nothing in
// this codebase ever revisits one after the fact, refund or not. Mostly a documented decision for now
// rather than something wired up - no real Stripe Connect payout exists yet either way (Module 9.1's
// own deferred decision), so nothing is actually transferred in any direction yet regardless.

export type PaymentRefundOutcome = 'refunded' | 'failed' | 'skipped';

/**
 * Refunds `tripId`'s own captured payment, if it can be refunded: only a CAPTURED trip with a known
 * final fare does. `amountMinorUnits` defaults to the whole final fare (a full refund); anything else
 * must be a positive amount no larger than it (a partial refund) - an invalid amount is 'skipped', not
 * an error, the same "not asked to guess" stance the rest of this module takes.
 */
export async function refundTripPayment(
  deps: { firestore: Firestore; stripe: StripeProvider },
  tripId: string,
  amountMinorUnits?: number,
): Promise<PaymentRefundOutcome> {
  const { firestore } = deps;
  const tripRef = firestore.collection('tripRequests').doc(tripId);
  const tripSnap = await tripRef.get();

  if (!tripSnap.exists || tripSnap.get('paymentStatus') !== 'CAPTURED') {
    return 'skipped';
  }

  const paymentIntentId = tripSnap.get('paymentIntentId');
  const finalFareMinorUnits = tripSnap.get('finalFareMinorUnits');
  if (
    typeof paymentIntentId !== 'string' ||
    !paymentIntentId ||
    typeof finalFareMinorUnits !== 'number'
  ) {
    return 'skipped';
  }

  const refundAmount = amountMinorUnits ?? finalFareMinorUnits;
  if (refundAmount <= 0 || refundAmount > finalFareMinorUnits) {
    return 'skipped';
  }

  const outcome = await deps.stripe.refundPayment({
    paymentIntentId,
    amountMinorUnits: refundAmount,
  });

  await firestore.runTransaction(async (tx) => {
    const current = await tx.get(tripRef);
    if (!current.exists || current.get('paymentStatus') !== 'CAPTURED') return;

    if (outcome.status === 'failed') {
      tx.create(firestore.collection('auditLogs').doc(), {
        timestamp: FieldValue.serverTimestamp(),
        actor: 'system',
        action: 'TRIP_PAYMENT_REFUND_FAILED',
        entity: `tripRequests/${tripId}`,
        previousState: { paymentStatus: 'CAPTURED' },
        newState: { paymentStatus: 'CAPTURED' },
        reason: 'The captured payment could not be refunded',
      });
      return;
    }

    const fullRefund = refundAmount === finalFareMinorUnits;
    tx.update(tripRef, {
      paymentStatus: fullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
      refundedAmountMinorUnits: refundAmount,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: 'system',
      action: 'TRIP_PAYMENT_REFUNDED',
      entity: `tripRequests/${tripId}`,
      previousState: { paymentStatus: 'CAPTURED' },
      newState: { paymentStatus: fullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
      reason: fullRefund ? 'Full refund issued' : 'Partial refund issued',
    });
  });

  return outcome.status === 'failed' ? 'failed' : 'refunded';
}
