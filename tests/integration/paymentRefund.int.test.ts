import { describe, expect, it } from 'vitest';
import { refundTripPayment } from '../../functions/src/paymentRefund';
import type { StripeProvider } from '../../functions/src/stripeProvider';
import { admin } from './support';

// Module 9.7's own refund logic, tested directly against refundTripPayment - not wired into any live
// trigger (see the file's own note on why: no refund-request flow or admin dashboard exists yet), the
// same "call the function directly" approach paymentCapture.int.test.ts's own tests take.

function fakeStripe(overrides: Partial<StripeProvider> = {}): StripeProvider {
  return {
    ping: async () => true,
    createCustomer: async () => 'cus_fake',
    authorizePayment: async () => ({ status: 'authorized', paymentIntentId: 'pi_fake' }),
    capturePayment: async () => ({ status: 'captured' }),
    voidPayment: async () => ({ status: 'voided' }),
    refundPayment: async () => ({ status: 'refunded' }),
    verifyWebhookEvent: () => ({ status: 'invalid' }),
    ...overrides,
  };
}

let counter = 0;

/** A CAPTURED trip request, ready to be refunded (final fare 800). */
async function capturedTrip(
  prefix: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  counter += 1;
  const tripRef = admin().firestore.collection('tripRequests').doc();
  await tripRef.set({
    passengerId: `${prefix}-passenger-${counter}`,
    status: 'COMPLETED',
    paymentIntentId: 'pi_fixture',
    paymentStatus: 'CAPTURED',
    finalFareMinorUnits: 800,
    ...overrides,
  });
  return tripRef.id;
}

const refund = (stripe: StripeProvider, tripId: string, amountMinorUnits?: number) =>
  refundTripPayment({ firestore: admin().firestore, stripe }, tripId, amountMinorUnits);

describe('refundTripPayment (functions + firestore emulator, fake Stripe)', () => {
  it('fully refunds the final fare by default, marking REFUNDED', async () => {
    const tripId = await capturedTrip('refund-full');
    const stripe = fakeStripe({
      refundPayment: async (params) => {
        expect(params).toEqual({ paymentIntentId: 'pi_fixture', amountMinorUnits: 800 });
        return { status: 'refunded' };
      },
    });

    expect(await refund(stripe, tripId)).toBe('refunded');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.paymentStatus).toBe('REFUNDED');
    expect(trip?.refundedAmountMinorUnits).toBe(800);

    const audit = (
      await admin()
        .firestore.collection('auditLogs')
        .where('entity', '==', `tripRequests/${tripId}`)
        .where('action', '==', 'TRIP_PAYMENT_REFUNDED')
        .get()
    ).docs;
    expect(audit).toHaveLength(1);
  });

  it('marks PARTIALLY_REFUNDED when a smaller amount is given', async () => {
    const tripId = await capturedTrip('refund-partial');

    expect(await refund(fakeStripe(), tripId, 300)).toBe('refunded');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.paymentStatus).toBe('PARTIALLY_REFUNDED');
    expect(trip?.refundedAmountMinorUnits).toBe(300);
  });

  it('leaves the trip CAPTURED and audits it when Stripe cannot refund', async () => {
    const tripId = await capturedTrip('refund-failed');

    expect(
      await refund(fakeStripe({ refundPayment: async () => ({ status: 'failed' }) }), tripId),
    ).toBe('failed');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.paymentStatus).toBe('CAPTURED');

    const audit = (
      await admin()
        .firestore.collection('auditLogs')
        .where('entity', '==', `tripRequests/${tripId}`)
        .where('action', '==', 'TRIP_PAYMENT_REFUND_FAILED')
        .get()
    ).docs;
    expect(audit).toHaveLength(1);
  });

  it('is skipped for a trip that is not CAPTURED', async () => {
    const tripId = await capturedTrip('refund-notcaptured', { paymentStatus: 'AUTHORIZED' });

    expect(await refund(fakeStripe(), tripId)).toBe('skipped');
  });

  it('is skipped when the amount is zero, negative, or larger than the final fare', async () => {
    const tripId = await capturedTrip('refund-badamount');

    expect(await refund(fakeStripe(), tripId, 0)).toBe('skipped');
    expect(await refund(fakeStripe(), tripId, -1)).toBe('skipped');
    expect(await refund(fakeStripe(), tripId, 801)).toBe('skipped');
  });

  it('is skipped, not double-refunded, once a trip is already REFUNDED', async () => {
    const tripId = await capturedTrip('refund-again', { paymentStatus: 'REFUNDED' });
    let calls = 0;
    const stripe = fakeStripe({
      refundPayment: async () => {
        calls += 1;
        return { status: 'refunded' };
      },
    });

    expect(await refund(stripe, tripId)).toBe('skipped');
    expect(calls).toBe(0);
  });
});
