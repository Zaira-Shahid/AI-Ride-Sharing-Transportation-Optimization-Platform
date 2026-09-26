import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { StripeProvider } from './stripeProvider.js';

// Module 9.9 (webhooks): the ONE thing nothing else in this codebase can learn any other way - a
// dispute (chargeback), which only ever arrives as a Stripe event, never something reachable by a
// synchronous call. Every other Stripe outcome (a hold authorizing/declining, a capture
// succeeding/failing, a hold being voided, a refund) already has its own direct call site (modules
// 9.2/9.4/9.7) - user-approved: this handles disputes ONLY, not a general-purpose event log/
// reconciliation system, since nothing else currently needs one.
//
// Signature verification (spec section 57's own "payment webhook verification" security requirement)
// happens first, via StripeProvider's own verifyWebhookEvent - an unverified payload is never trusted,
// the same server-authoritative stance the payment state machine (spec section 74) takes throughout
// this whole phase. index.ts's own endpoint passes the raw request body, never anything re-parsed.

export type WebhookOutcome = 'disputed' | 'ignored' | 'invalid';

interface StripeDisputeLike {
  payment_intent: string | { id: string } | null;
}

export async function handleStripeWebhook(
  deps: { firestore: Firestore; stripe: StripeProvider },
  payload: string | Buffer,
  signature: string,
  webhookSecret: string,
): Promise<WebhookOutcome> {
  const verified = deps.stripe.verifyWebhookEvent({ payload, signature, webhookSecret });
  if (verified.status === 'invalid') return 'invalid';

  const { event } = verified;
  if (event.type !== 'charge.dispute.created') return 'ignored';

  const dispute = event.data.object as unknown as StripeDisputeLike;
  const paymentIntentId =
    typeof dispute.payment_intent === 'string'
      ? dispute.payment_intent
      : dispute.payment_intent?.id;
  if (!paymentIntentId) return 'ignored';

  const { firestore } = deps;
  const tripQuery = await firestore
    .collection('tripRequests')
    .where('paymentIntentId', '==', paymentIntentId)
    .limit(1)
    .get();
  if (tripQuery.empty) return 'ignored';
  const tripRef = tripQuery.docs[0]!.ref;

  await firestore.runTransaction(async (tx) => {
    const current = await tx.get(tripRef);
    const previousStatus = current.get('paymentStatus');
    if (!current.exists || previousStatus === 'DISPUTED') return;

    tx.update(tripRef, { paymentStatus: 'DISPUTED', updatedAt: FieldValue.serverTimestamp() });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: 'system',
      action: 'TRIP_PAYMENT_DISPUTED',
      entity: `tripRequests/${tripRef.id}`,
      previousState: { paymentStatus: previousStatus },
      newState: { paymentStatus: 'DISPUTED' },
      reason: 'Stripe reported a dispute (chargeback) on this payment',
    });
  });

  return 'disputed';
}
