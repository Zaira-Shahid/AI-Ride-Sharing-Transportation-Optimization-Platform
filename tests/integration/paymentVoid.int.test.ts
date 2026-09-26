import { describe, expect, it } from 'vitest';
import { voidStaleAuthorization } from '../../functions/src/paymentVoid';
import type { StripeProvider } from '../../functions/src/stripeProvider';
import { admin } from './support';

// Module 9.7's own void logic, tested directly against voidStaleAuthorization (not wired into any
// live trigger except voidStaleAuthorizationOnRelease, which reacts to a real release path and has no
// dedicated test of its own - see the file's own note on why) with a fake StripeProvider, the same
// approach paymentCapture.int.test.ts's own tests take.

function fakeStripe(overrides: Partial<StripeProvider> = {}): StripeProvider {
  return {
    ping: async () => true,
    createCustomer: async () => 'cus_fake',
    authorizePayment: async () => ({ status: 'authorized', paymentIntentId: 'pi_fake' }),
    capturePayment: async () => ({ status: 'captured' }),
    voidPayment: async () => ({ status: 'voided' }),
    refundPayment: async () => ({ status: 'refunded' }),
    ...overrides,
  };
}

let counter = 0;

/** A trip request with an AUTHORIZED hold, released back to `status`, ready to be voided. */
async function releasedTrip(
  prefix: string,
  status: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  counter += 1;
  const tripRef = admin().firestore.collection('tripRequests').doc();
  await tripRef.set({
    passengerId: `${prefix}-passenger-${counter}`,
    status,
    paymentIntentId: 'pi_fixture',
    paymentStatus: 'AUTHORIZED',
    authorizedAmountMinorUnits: 1_200,
    ...overrides,
  });
  return tripRef.id;
}

const voidHold = (stripe: StripeProvider, tripId: string) =>
  voidStaleAuthorization({ firestore: admin().firestore, stripe }, tripId);

describe('voidStaleAuthorization (functions + firestore emulator, fake Stripe)', () => {
  it('voids the hold and resets payment fields to null when released to SEARCHING', async () => {
    const tripId = await releasedTrip('void-searching', 'SEARCHING');
    const stripe = fakeStripe({
      voidPayment: async (params) => {
        expect(params).toEqual({ paymentIntentId: 'pi_fixture' });
        return { status: 'voided' };
      },
    });

    expect(await voidHold(stripe, tripId)).toBe('voided');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.paymentStatus).toBeNull();
    expect(trip?.paymentIntentId).toBeNull();
    expect(trip?.authorizedAmountMinorUnits).toBeNull();
  });

  it('also voids a hold when released to CANCELLED', async () => {
    const tripId = await releasedTrip('void-cancelled', 'CANCELLED');

    expect(await voidHold(fakeStripe(), tripId)).toBe('voided');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.paymentStatus).toBeNull();
  });

  it('leaves the trip AUTHORIZED and audits it when Stripe cannot void the hold', async () => {
    const tripId = await releasedTrip('void-failed', 'SEARCHING');

    expect(
      await voidHold(fakeStripe({ voidPayment: async () => ({ status: 'failed' }) }), tripId),
    ).toBe('failed');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.paymentStatus).toBe('AUTHORIZED');
    expect(trip?.paymentIntentId).toBe('pi_fixture');

    const audit = (
      await admin()
        .firestore.collection('auditLogs')
        .where('entity', '==', `tripRequests/${tripId}`)
        .where('action', '==', 'TRIP_PAYMENT_VOID_FAILED')
        .get()
    ).docs;
    expect(audit).toHaveLength(1);
  });

  it('is skipped for a trip that is not released (still matched)', async () => {
    const tripId = await releasedTrip('void-notreleased', 'PICKUP_ASSIGNED');

    expect(await voidHold(fakeStripe(), tripId)).toBe('skipped');
  });

  it('is skipped when the payment was never authorized', async () => {
    const tripId = await releasedTrip('void-noauth', 'SEARCHING', {
      paymentIntentId: null,
      paymentStatus: null,
    });

    expect(await voidHold(fakeStripe(), tripId)).toBe('skipped');
  });

  it('is skipped, not re-voided, once a trip is already captured', async () => {
    const tripId = await releasedTrip('void-captured', 'SEARCHING', { paymentStatus: 'CAPTURED' });
    let calls = 0;
    const stripe = fakeStripe({
      voidPayment: async () => {
        calls += 1;
        return { status: 'voided' };
      },
    });

    expect(await voidHold(stripe, tripId)).toBe('skipped');
    expect(calls).toBe(0);
  });
});
