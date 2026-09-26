import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { StripeProvider } from './stripeProvider.js';

// Module 9.7 (refunds), first half - voiding a stale AUTHORIZED hold. Several existing release paths
// (availability.ts's releaseMatchedTrips for Module 8.5 driver cancellation, routeModification.ts's
// releaseDroppedRequest for Module 8.7) move a trip that may have an AUTHORIZED hold on it (Module 9.2
// places one at PICKUP_ASSIGNED) back to SEARCHING, without knowing anything about payments - by
// design, the same separation of concerns as everywhere else in this codebase (8.5/8.7 own the match
// state, not the payment state). Rather than threading a StripeProvider through every one of those
// call sites (and every future one that might release a matched trip), a single trigger
// (voidStaleAuthorizationOnRelease, index.ts) watches tripRequests for exactly this pattern - a trip
// that WAS AUTHORIZED and just moved to SEARCHING or CANCELLED - and voids the hold here. This also
// means a future release path needs no changes to get this for free.
//
// A void failing is left AUTHORIZED and audited for follow-up (a future webhooks module, or Stripe's
// own hold expiry after about a week, are what actually resolve it) - the same "mark it and stop"
// stance Module 9.4's own capture failure takes, since there is nothing better to fall back to here
// either.

export type PaymentVoidOutcome = 'voided' | 'failed' | 'skipped';

const RELEASED_STATUSES = new Set(['SEARCHING', 'CANCELLED']);

/**
 * Voids `tripId`'s own stale hold, if it has one: only a trip currently AUTHORIZED and currently
 * SEARCHING or CANCELLED does (safe to call more than once - already voided/captured/never-authorized
 * trips are left alone, 'skipped').
 */
export async function voidStaleAuthorization(
  deps: { firestore: Firestore; stripe: StripeProvider },
  tripId: string,
): Promise<PaymentVoidOutcome> {
  const { firestore } = deps;
  const tripRef = firestore.collection('tripRequests').doc(tripId);
  const tripSnap = await tripRef.get();

  if (!tripSnap.exists || tripSnap.get('paymentStatus') !== 'AUTHORIZED') {
    return 'skipped';
  }
  if (!RELEASED_STATUSES.has(tripSnap.get('status'))) {
    return 'skipped';
  }

  const paymentIntentId = tripSnap.get('paymentIntentId');
  if (typeof paymentIntentId !== 'string' || !paymentIntentId) {
    return 'skipped';
  }

  const outcome = await deps.stripe.voidPayment({ paymentIntentId });

  await firestore.runTransaction(async (tx) => {
    const current = await tx.get(tripRef);
    if (!current.exists || current.get('paymentStatus') !== 'AUTHORIZED') return;

    if (outcome.status === 'failed') {
      tx.create(firestore.collection('auditLogs').doc(), {
        timestamp: FieldValue.serverTimestamp(),
        actor: 'system',
        action: 'TRIP_PAYMENT_VOID_FAILED',
        entity: `tripRequests/${tripId}`,
        previousState: { paymentStatus: 'AUTHORIZED' },
        newState: { paymentStatus: 'AUTHORIZED' },
        reason: 'The held payment could not be voided',
      });
      return;
    }

    // Back to a fresh, un-authorized state - a later match will authorize again from scratch.
    tx.update(tripRef, {
      paymentStatus: null,
      paymentIntentId: null,
      authorizedAmountMinorUnits: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return outcome.status === 'failed' ? 'failed' : 'voided';
}
