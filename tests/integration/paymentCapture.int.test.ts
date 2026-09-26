import { describe, expect, it } from 'vitest';
import { captureTripPayment } from '../../functions/src/paymentCapture';
import type { StripeProvider } from '../../functions/src/stripeProvider';
import { admin } from './support';

// Module 9.4's own capture logic, tested directly against captureTripPayment (not wired into any live
// trigger except completeDropoff, which has its own tests) with a fake StripeProvider - the same
// approach paymentAuthorization.int.test.ts's own tests take.

function fakeStripe(overrides: Partial<StripeProvider> = {}): StripeProvider {
  return {
    ping: async () => true,
    createCustomer: async () => 'cus_fake',
    authorizePayment: async () => ({ status: 'authorized', paymentIntentId: 'pi_fake' }),
    capturePayment: async () => ({ status: 'captured' }),
    ...overrides,
  };
}

let counter = 0;

/** A COMPLETED trip request with an AUTHORIZED hold and a known final fare, ready to be captured. */
async function capturedTrip(
  prefix: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  counter += 1;
  const tripRef = admin().firestore.collection('tripRequests').doc();
  await tripRef.set({
    passengerId: `${prefix}-passenger-${counter}`,
    matchedDriverId: `${prefix}-driver-${counter}`,
    status: 'COMPLETED',
    paymentIntentId: 'pi_fixture',
    paymentStatus: 'AUTHORIZED',
    finalFareMinorUnits: 800,
    platformFeeMinorUnits: 160,
    authorizedAmountMinorUnits: 1_200,
    ...overrides,
  });
  return tripRef.id;
}

const capture = (stripe: StripeProvider, tripId: string) =>
  captureTripPayment({ firestore: admin().firestore, stripe }, tripId);

describe('captureTripPayment (functions + firestore emulator, fake Stripe)', () => {
  it('captures exactly the final fare (not the full authorized hold) and marks CAPTURED', async () => {
    const tripId = await capturedTrip('capture-ok');
    const stripe = fakeStripe({
      capturePayment: async (params) => {
        expect(params).toEqual({ paymentIntentId: 'pi_fixture', amountMinorUnits: 800 });
        return { status: 'captured' };
      },
    });

    expect(await capture(stripe, tripId)).toBe('captured');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.paymentStatus).toBe('CAPTURED');
  });

  it('marks FAILED and audits it when Stripe cannot capture (ride already happened - no release)', async () => {
    const tripId = await capturedTrip('capture-failed');

    expect(
      await capture(fakeStripe({ capturePayment: async () => ({ status: 'failed' }) }), tripId),
    ).toBe('failed');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.paymentStatus).toBe('FAILED');
    expect(trip?.status).toBe('COMPLETED');

    const audit = (
      await admin()
        .firestore.collection('auditLogs')
        .where('entity', '==', `tripRequests/${tripId}`)
        .where('action', '==', 'TRIP_PAYMENT_CAPTURE_FAILED')
        .get()
    ).docs;
    expect(audit).toHaveLength(1);
  });

  it('is skipped for a trip that is not COMPLETED', async () => {
    const tripId = await capturedTrip('capture-notdone', { status: 'DROPOFF_APPROACHING' });

    expect(await capture(fakeStripe(), tripId)).toBe('skipped');
  });

  it('is skipped when the payment was never authorized', async () => {
    const tripId = await capturedTrip('capture-noauth', {
      paymentIntentId: null,
      paymentStatus: null,
    });

    expect(await capture(fakeStripe(), tripId)).toBe('skipped');
  });

  it('is skipped, not re-captured, once a trip is already CAPTURED', async () => {
    const tripId = await capturedTrip('capture-again', { paymentStatus: 'CAPTURED' });
    let calls = 0;
    const stripe = fakeStripe({
      capturePayment: async () => {
        calls += 1;
        return { status: 'captured' };
      },
    });

    expect(await capture(stripe, tripId)).toBe('skipped');
    expect(calls).toBe(0);
  });

  it('is skipped when the final fare is not yet known', async () => {
    const tripId = await capturedTrip('capture-nofare', { finalFareMinorUnits: null });

    expect(await capture(fakeStripe(), tripId)).toBe('skipped');
  });

  describe('driver earnings ledger entry (Module 9.5)', () => {
    it('records final fare minus platform fee, in the config currency, on a successful capture', async () => {
      const tripId = await capturedTrip('capture-earns', { matchedDriverId: 'earns-driver-1' });

      expect(await capture(fakeStripe(), tripId)).toBe('captured');

      const entries = (
        await admin().firestore.collection('driverEarnings').where('tripId', '==', tripId).get()
      ).docs;
      expect(entries).toHaveLength(1);
      expect(entries[0]?.data()).toMatchObject({
        driverId: 'earns-driver-1',
        tripId,
        amountMinorUnits: 640,
        currency: 'usd',
      });
    });

    it('records nothing when the capture fails', async () => {
      const tripId = await capturedTrip('capture-earns-failed');

      expect(
        await capture(fakeStripe({ capturePayment: async () => ({ status: 'failed' }) }), tripId),
      ).toBe('failed');

      const entries = (
        await admin().firestore.collection('driverEarnings').where('tripId', '==', tripId).get()
      ).docs;
      expect(entries).toHaveLength(0);
    });

    it('captures the payment but records nothing when the trip has no matched driver', async () => {
      const tripId = await capturedTrip('capture-earns-nodriver', { matchedDriverId: null });

      expect(await capture(fakeStripe(), tripId)).toBe('captured');

      const entries = (
        await admin().firestore.collection('driverEarnings').where('tripId', '==', tripId).get()
      ).docs;
      expect(entries).toHaveLength(0);
    });
  });
});
