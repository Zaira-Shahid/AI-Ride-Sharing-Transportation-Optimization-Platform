import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { StripeProvider } from './stripeProvider.js';

// Module 9.4 (payment capture): once a trip is COMPLETED and its final fare is known (Module 9.3),
// captures exactly finalFareMinorUnits from the hold Module 9.2 placed - never the full authorized
// amount, which included fare.ts's own AUTHORIZATION_BUFFER_PERCENT precisely so a lower amount could
// be captured later without a second authorization. A trip whose payment was never authorized (no
// paymentIntentId - the expected case today, since nothing is wired into the live match pipeline
// until a real card-entry UI exists) is simply skipped, the same "nothing to do here" stance
// authorizeTripPayment's own 'skipped' already takes.
//
// A capture failing AFTER the ride is already complete is a fundamentally different situation from an
// authorization declining before pickup (Module 9.2): there is no "back to the open pool" to fall
// back to - the passenger already got their ride. User-approved: mark paymentStatus FAILED and stop;
// a future module (webhooks, an admin dashboard, a retry/dunning flow) is what actually resolves it,
// not this one.

export type PaymentCaptureOutcome = 'captured' | 'failed' | 'skipped';

/**
 * Captures `tripId`'s own held payment, if it needs capturing: only a COMPLETED trip with an
 * AUTHORIZED payment and a known final fare does (safe to call more than once - already
 * captured/failed/never-authorized trips are left alone, 'skipped').
 */
export async function captureTripPayment(
  deps: { firestore: Firestore; stripe: StripeProvider },
  tripId: string,
): Promise<PaymentCaptureOutcome> {
  const { firestore } = deps;
  const tripRef = firestore.collection('tripRequests').doc(tripId);
  const tripSnap = await tripRef.get();

  if (
    !tripSnap.exists ||
    tripSnap.get('status') !== 'COMPLETED' ||
    tripSnap.get('paymentStatus') !== 'AUTHORIZED'
  ) {
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

  const outcome = await deps.stripe.capturePayment({
    paymentIntentId,
    amountMinorUnits: finalFareMinorUnits,
  });

  await firestore.runTransaction(async (tx) => {
    const current = await tx.get(tripRef);
    if (!current.exists || current.get('paymentStatus') !== 'AUTHORIZED') return;

    if (outcome.status === 'failed') {
      tx.update(tripRef, { paymentStatus: 'FAILED', updatedAt: FieldValue.serverTimestamp() });
      tx.create(firestore.collection('auditLogs').doc(), {
        timestamp: FieldValue.serverTimestamp(),
        actor: 'system',
        action: 'TRIP_PAYMENT_CAPTURE_FAILED',
        entity: `tripRequests/${tripId}`,
        previousState: { paymentStatus: 'AUTHORIZED' },
        newState: { paymentStatus: 'FAILED' },
        reason: 'Payment could not be captured',
      });
    } else {
      tx.update(tripRef, { paymentStatus: 'CAPTURED', updatedAt: FieldValue.serverTimestamp() });
    }
  });

  return outcome.status === 'failed' ? 'failed' : 'captured';
}
