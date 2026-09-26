import { describe, expect, it } from 'vitest';
import { handleStripeWebhook } from '../../functions/src/paymentWebhook';
import type { StripeProvider, VerifyWebhookEventOutcome } from '../../functions/src/stripeProvider';
import { admin } from './support';

// Module 9.9's own webhook logic, tested directly against handleStripeWebhook (not through the real
// stripeWebhook HTTP endpoint, which has no fake StripeProvider to inject) with a fake StripeProvider
// whose verifyWebhookEvent is fully controlled - the same "call the function directly" approach
// paymentCapture.int.test.ts's own tests take. Signature verification itself is stripeProvider.test.ts's
// own unit tests' job; this file is only about what happens once an event is (or is not) verified.

function fakeStripe(verify: () => VerifyWebhookEventOutcome): StripeProvider {
  return {
    ping: async () => true,
    createCustomer: async () => 'cus_fake',
    authorizePayment: async () => ({ status: 'authorized', paymentIntentId: 'pi_fake' }),
    capturePayment: async () => ({ status: 'captured' }),
    voidPayment: async () => ({ status: 'voided' }),
    refundPayment: async () => ({ status: 'refunded' }),
    verifyWebhookEvent: verify,
  };
}

let counter = 0;

async function tripWithPaymentIntent(prefix: string, paymentIntentId: string): Promise<string> {
  counter += 1;
  const tripRef = admin().firestore.collection('tripRequests').doc();
  await tripRef.set({
    passengerId: `${prefix}-passenger-${counter}`,
    status: 'COMPLETED',
    paymentIntentId,
    paymentStatus: 'CAPTURED',
  });
  return tripRef.id;
}

const disputeEvent = (paymentIntentId: string) => ({
  status: 'verified' as const,
  event: {
    type: 'charge.dispute.created',
    data: { object: { payment_intent: paymentIntentId } },
  } as never,
});

const handle = (stripe: StripeProvider) =>
  handleStripeWebhook({ firestore: admin().firestore, stripe }, '{}', 'sig', 'whsec_test');

describe('handleStripeWebhook (functions + firestore emulator, fake Stripe)', () => {
  it('is invalid when the signature does not verify', async () => {
    expect(await handle(fakeStripe(() => ({ status: 'invalid' })))).toBe('invalid');
  });

  it('is ignored for an event type it does not act on', async () => {
    const stripe = fakeStripe(() => ({
      status: 'verified',
      event: { type: 'payment_intent.succeeded', data: { object: {} } } as never,
    }));
    expect(await handle(stripe)).toBe('ignored');
  });

  it('is ignored when a dispute references a payment intent with no matching trip', async () => {
    const stripe = fakeStripe(() => disputeEvent('pi_does_not_exist'));
    expect(await handle(stripe)).toBe('ignored');
  });

  it('marks the matching trip DISPUTED and audits it', async () => {
    const tripId = await tripWithPaymentIntent('webhook-disputed', 'pi_disputed_1');
    const stripe = fakeStripe(() => disputeEvent('pi_disputed_1'));

    expect(await handle(stripe)).toBe('disputed');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.paymentStatus).toBe('DISPUTED');

    const audit = (
      await admin()
        .firestore.collection('auditLogs')
        .where('entity', '==', `tripRequests/${tripId}`)
        .where('action', '==', 'TRIP_PAYMENT_DISPUTED')
        .get()
    ).docs;
    expect(audit).toHaveLength(1);
  });

  it('is idempotent - a second dispute event for an already-DISPUTED trip audits nothing new', async () => {
    const tripId = await tripWithPaymentIntent('webhook-again', 'pi_disputed_2');
    const stripe = fakeStripe(() => disputeEvent('pi_disputed_2'));

    expect(await handle(stripe)).toBe('disputed');
    expect(await handle(stripe)).toBe('disputed');

    const audit = (
      await admin()
        .firestore.collection('auditLogs')
        .where('entity', '==', `tripRequests/${tripId}`)
        .where('action', '==', 'TRIP_PAYMENT_DISPUTED')
        .get()
    ).docs;
    expect(audit).toHaveLength(1);
  });
});
