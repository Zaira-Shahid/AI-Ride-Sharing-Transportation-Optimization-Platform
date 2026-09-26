import { describe, expect, it } from 'vitest';
import { authorizeTripPayment } from '../../functions/src/paymentAuthorization';
import type { StripeProvider } from '../../functions/src/stripeProvider';
import { admin } from './support';

// Module 9.2's own authorization logic, tested directly against authorizeTripPayment (not wired into
// any live trigger yet - see the file's own note on why) with a fake StripeProvider, the same approach
// paymentMethods.int.test.ts's own tests take. Fixtures are built directly with the admin SDK (a
// MATCHING journey and its matched, not-yet-picked-up trip request) rather than through the real
// matching pipeline, which has its own tests.

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
function nextClusterBase(): number {
  counter += 1;
  return 30 + counter * 2;
}

interface Fixture {
  journeyId: string;
  tripId: string;
  passengerId: string;
}

/**
 * A MATCHING journey with one PICKUP_ASSIGNED trip request, estimated at 5 km / 10 minutes (so, with
 * DEFAULT_FARE_CONFIG, a plain fare of 250 + 120*5 + 15*10 = 1000 and an authorized hold of 1200 - the
 * same numbers fare.test.ts's own unit tests use). `hasPaymentMethod` controls whether the passenger's
 * own user doc has one saved.
 */
async function matchedTrip(
  prefix: string,
  options: { hasPaymentMethod: boolean; otherTripIds?: string[] } = { hasPaymentMethod: true },
): Promise<Fixture> {
  const base = nextClusterBase();
  const driverId = `${prefix}-driver-${counter}`;
  const passengerId = `${prefix}-passenger-${counter}`;
  const journeyRef = admin().firestore.collection('driverJourneys').doc();
  const tripRef = admin().firestore.collection('tripRequests').doc();
  const otherTripIds = options.otherTripIds ?? [];

  await journeyRef.set({
    driverId,
    status: 'MATCHING',
    origin: { latitude: base, longitude: 90 },
    destination: { latitude: base + 0.05, longitude: 90 },
    availableSeats: 3,
    matchedTripRequestIds: [tripRef.id, ...otherTripIds],
  });
  await admin()
    .firestore.doc(`users/${passengerId}`)
    .set({
      role: 'PASSENGER',
      name: 'Pat',
      email: `${passengerId}@example.test`,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(options.hasPaymentMethod
        ? { stripeCustomerId: 'cus_existing', paymentMethodId: 'pm_existing' }
        : {}),
    });
  await tripRef.set({
    passengerId,
    status: 'PICKUP_ASSIGNED',
    matchedJourneyId: journeyRef.id,
    matchedDriverId: driverId,
    driverName: 'Test Driver',
    vehicleType: 'CAR',
    estimatedDistance: 5_000,
    estimatedDuration: 600,
    paymentIntentId: null,
  });

  return { journeyId: journeyRef.id, tripId: tripRef.id, passengerId };
}

const authorize = (stripe: StripeProvider, tripId: string) =>
  authorizeTripPayment({ firestore: admin().firestore, stripe }, tripId);

describe('authorizeTripPayment (functions + firestore emulator, fake Stripe)', () => {
  it('authorizes the estimate plus the buffer, and stores the result', async () => {
    const fixture = await matchedTrip('auth-ok');
    const stripe = fakeStripe({
      authorizePayment: async (params) => {
        expect(params).toMatchObject({
          stripeCustomerId: 'cus_existing',
          paymentMethodId: 'pm_existing',
          amountMinorUnits: 1_200,
          currency: 'usd',
        });
        return { status: 'authorized', paymentIntentId: 'pi_ok' };
      },
    });

    expect(await authorize(stripe, fixture.tripId)).toBe('authorized');

    const trip = (await admin().firestore.doc(`tripRequests/${fixture.tripId}`).get()).data();
    expect(trip?.paymentIntentId).toBe('pi_ok');
    expect(trip?.paymentStatus).toBe('AUTHORIZED');
    expect(trip?.estimatedFare).toBe(1_000);
    expect(trip?.authorizedAmountMinorUnits).toBe(1_200);
    expect(trip?.status).toBe('PICKUP_ASSIGNED');
  });

  it('releases the passenger to SEARCHING and reverts the journey to AVAILABLE when nobody has a payment method', async () => {
    const fixture = await matchedTrip('auth-nomethod', { hasPaymentMethod: false });

    expect(await authorize(fakeStripe(), fixture.tripId)).toBe('declined');

    const trip = (await admin().firestore.doc(`tripRequests/${fixture.tripId}`).get()).data();
    expect(trip?.status).toBe('SEARCHING');
    expect(trip?.matchedJourneyId).toBeNull();
    expect(trip?.driverName).toBeNull();

    const journey = (
      await admin().firestore.doc(`driverJourneys/${fixture.journeyId}`).get()
    ).data();
    expect(journey?.status).toBe('AVAILABLE');
    expect(journey?.matchedTripRequestIds).toEqual([]);

    const notifications = (
      await admin()
        .firestore.collection('notifications')
        .where('relatedEntity', '==', `tripRequests/${fixture.tripId}`)
        .get()
    ).docs;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.data()).toMatchObject({
      recipientId: fixture.passengerId,
      type: 'RELEASED_TO_SEARCHING',
    });

    const audit = (
      await admin()
        .firestore.collection('auditLogs')
        .where('entity', '==', `tripRequests/${fixture.tripId}`)
        .where('action', '==', 'TRIP_UNMATCHED_PAYMENT_DECLINED')
        .get()
    ).docs;
    expect(audit).toHaveLength(1);
  });

  it('releases the passenger when Stripe declines the hold, keeping the journey MATCHING if another passenger remains', async () => {
    const otherTripId = admin().firestore.collection('tripRequests').doc().id;
    const fixture = await matchedTrip('auth-declined', {
      hasPaymentMethod: true,
      otherTripIds: [otherTripId],
    });

    expect(
      await authorize(
        fakeStripe({ authorizePayment: async () => ({ status: 'declined' }) }),
        fixture.tripId,
      ),
    ).toBe('declined');

    const journey = (
      await admin().firestore.doc(`driverJourneys/${fixture.journeyId}`).get()
    ).data();
    expect(journey?.status).toBe('MATCHING');
    expect(journey?.matchedTripRequestIds).toEqual([otherTripId]);
  });

  it('is skipped for a trip that is not freshly matched', async () => {
    const fixture = await matchedTrip('auth-notmatched');
    await admin().firestore.doc(`tripRequests/${fixture.tripId}`).update({ status: 'SEARCHING' });

    expect(await authorize(fakeStripe(), fixture.tripId)).toBe('skipped');
  });

  it('is skipped, not re-authorized, once a trip already has a payment intent', async () => {
    const fixture = await matchedTrip('auth-already');
    await admin()
      .firestore.doc(`tripRequests/${fixture.tripId}`)
      .update({ paymentIntentId: 'pi_existing' });
    let calls = 0;
    const stripe = fakeStripe({
      authorizePayment: async () => {
        calls += 1;
        return { status: 'authorized', paymentIntentId: 'pi_should_not_happen' };
      },
    });

    expect(await authorize(stripe, fixture.tripId)).toBe('skipped');
    expect(calls).toBe(0);
  });
});
