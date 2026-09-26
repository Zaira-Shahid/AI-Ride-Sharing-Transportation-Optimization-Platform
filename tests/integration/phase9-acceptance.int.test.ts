import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import { authorizeTripPayment } from '../../functions/src/paymentAuthorization';
import { voidStaleAuthorization } from '../../functions/src/paymentVoid';
import type { PushProvider, SendPushParams } from '../../functions/src/pushProvider';
import type { StripeProvider } from '../../functions/src/stripeProvider';
import { completeDropoff as driverCompleteDropoff } from '../../functions/src/tripExecution';
import { admin, createClient, signUp, verifyEmail } from './support';

// Module 10.4 (payment captured push): records what the acceptance test's own driverCompleteDropoff
// call sends, to check it actually fires.
function recordingPush(): PushProvider & { sent: SendPushParams[] } {
  const sent: SendPushParams[] = [];
  return {
    sent,
    sendPush: (params) => {
      sent.push(params);
      return Promise.resolve({ status: 'sent' });
    },
  };
}

// Phase 9 acceptance ("Complete trip -> automatic payment -> earnings record"): the spec's own
// Stripe flow (section 9) end to end, through every module this phase built (9.1-9.8), plus the
// void half of 9.7 - except authorizeTripPayment's own live match-pipeline wiring and the webhook's
// dispute path (module 9.9), which are still deliberately unwired/event-only and already have their
// own dedicated tests (paymentAuthorization.int.test.ts's own note on why; paymentWebhook.int.test.ts).
// A driver/passenger/journey/trip is built directly with the admin SDK at PICKUP_ASSIGNED (the same
// "skip the real matching pipeline, which has its own tests" approach paymentAuthorization.int.test.ts
// already takes) - this file's own seam is the payment lifecycle across a real trip's own execution
// steps (module 7.2/7.4/7.5's own callables), not matching. completeDropoff is called directly (not
// through the real callable, which never gets a StripeProvider without STRIPE_SECRET_KEY set) so a
// fake one can be injected - the same approach tripExecution.int.test.ts's own capture tests take.

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

async function person(role: 'DRIVER' | 'PASSENGER', prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
  await verifyEmail(user, email);
  const call = (name: string, data: unknown) => httpsCallable(client.functions, name)(data);
  return { client, uid, call };
}

let counter = 0;

/** A MATCHING journey with one PICKUP_ASSIGNED trip request, estimated at 5 km / 10 minutes. */
async function matchedTrip(prefix: string) {
  counter += 1;
  const driver = await person('DRIVER', `${prefix}-driver-${counter}`);
  const passenger = await person('PASSENGER', `${prefix}-passenger-${counter}`);
  const journeyRef = admin().firestore.collection('driverJourneys').doc();
  const tripRef = admin().firestore.collection('tripRequests').doc();

  await journeyRef.set({
    driverId: driver.uid,
    status: 'MATCHING',
    matchedTripRequestIds: [tripRef.id],
  });
  await admin().firestore.doc(`users/${passenger.uid}`).update({
    stripeCustomerId: 'cus_existing',
    paymentMethodId: 'pm_existing',
  });
  await tripRef.set({
    passengerId: passenger.uid,
    status: 'PICKUP_ASSIGNED',
    matchedJourneyId: journeyRef.id,
    matchedDriverId: driver.uid,
    estimatedDistance: 5_000,
    estimatedDuration: 600,
    sharedRide: false,
    paymentIntentId: null,
    paymentStatus: null,
    finalFareMinorUnits: null,
    platformFeeMinorUnits: null,
  });

  return { driver, passenger, journeyRef, tripRef };
}

describe('Phase 9 acceptance (functions + firestore emulators)', () => {
  it('authorizes at pickup, finalizes and captures the fare at completion, and records driver earnings and a receipt', async () => {
    const { driver, passenger, tripRef } = await matchedTrip('p9a');
    await admin()
      .firestore.doc(`users/${driver.uid}`)
      .update({ pushToken: 'ExponentPushToken[driver]' });
    await admin()
      .firestore.doc(`users/${passenger.uid}`)
      .update({ pushToken: 'ExponentPushToken[passenger]' });

    // Module 9.2: a hold for the estimate plus AUTHORIZATION_BUFFER_PERCENT - 250+120*5+15*10=1000,
    // *1.2 = 1200.
    const authOutcome = await authorizeTripPayment(
      { firestore: admin().firestore, stripe: fakeStripe(), push: recordingPush() },
      tripRef.id,
    );
    expect(authOutcome).toBe('authorized');
    const tripAfterAuth = (await tripRef.get()).data();
    expect(tripAfterAuth?.paymentStatus).toBe('AUTHORIZED');
    expect(tripAfterAuth?.authorizedAmountMinorUnits).toBe(1_200);

    // Modules 7.2/7.4/7.5: the driver's own real, manual execution steps - untouched by payments.
    for (const action of ['headToPickup', 'confirmPickup', 'startTransit', 'approachDropoff']) {
      const result = await driver.call(action, { tripId: tripRef.id });
      expect((result.data as { status: string }).status).toBe('updated');
    }

    // Modules 9.3/9.4: completeDropoff finalizes the fare (the plain 1000, no shared discount) and
    // captures exactly that - never the full 1200 buffer.
    let capturedAmount: number | null = null;
    const push = recordingPush();
    const result = await driverCompleteDropoff(
      {
        firestore: admin().firestore,
        stripe: fakeStripe({
          capturePayment: async (params) => {
            capturedAmount = params.amountMinorUnits;
            return { status: 'captured' };
          },
        }),
        push,
      },
      { uid: driver.uid, role: 'DRIVER', emailVerified: true },
      { tripId: tripRef.id },
    );
    expect(result.status).toBe('updated');
    expect(capturedAmount).toBe(1_000);

    const tripFinal = (await tripRef.get()).data();
    expect(tripFinal?.status).toBe('COMPLETED');
    expect(tripFinal?.finalFareMinorUnits).toBe(1_000);
    expect(tripFinal?.platformFeeMinorUnits).toBe(200);
    expect(tripFinal?.paymentStatus).toBe('CAPTURED');

    // Module 9.5: the driver's own earnings ledger entry - final fare minus the platform fee.
    const earnings = (
      await admin().firestore.collection('driverEarnings').where('tripId', '==', tripRef.id).get()
    ).docs;
    expect(earnings).toHaveLength(1);
    expect(earnings[0]?.data()).toMatchObject({
      driverId: driver.uid,
      amountMinorUnits: 800,
      currency: 'usd',
    });

    // Module 9.8: the passenger's own receipt - no platform fee shown.
    const receipts = (
      await admin().firestore.collection('receipts').where('tripId', '==', tripRef.id).get()
    ).docs;
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]?.data();
    expect(receipt).toMatchObject({
      passengerId: tripFinal?.passengerId,
      totalMinorUnits: 1_000,
      sharedRideDiscountMinorUnits: 0,
    });
    expect(receipt).not.toHaveProperty('platformFeeMinorUnits');

    // Module 10.4: both the passenger (charged $10.00, the final fare) and the driver (earned $8.00,
    // the final fare minus the platform fee) get a push. Sent concurrently (Promise.all), so order
    // between the two is not guaranteed.
    expect(push.sent).toHaveLength(2);
    expect(push.sent).toContainEqual({
      token: 'ExponentPushToken[passenger]',
      title: 'Payment captured',
      body: 'You were charged $10.00 for your trip.',
    });
    expect(push.sent).toContainEqual({
      token: 'ExponentPushToken[driver]',
      title: 'You got paid',
      body: 'You earned $8.00 for this trip.',
    });
  }, 60_000);

  it('voids the stale hold, not collecting anything, when the trip is released before completion', async () => {
    const { tripRef } = await matchedTrip('p9a-release');

    await authorizeTripPayment(
      { firestore: admin().firestore, stripe: fakeStripe(), push: recordingPush() },
      tripRef.id,
    );
    expect((await tripRef.get()).get('paymentStatus')).toBe('AUTHORIZED');

    // Whatever released this trip (Module 8.5 driver cancellation, 8.7 route modification - both
    // already have their own dedicated tests) leaves an authorized hold with nowhere to go; simulate
    // just the release itself.
    await tripRef.update({ status: 'SEARCHING', matchedJourneyId: null, matchedDriverId: null });

    // Module 9.7 (the live voidStaleAuthorizationOnRelease trigger, in the real deployment): voids the
    // hold and resets payment fields so a later match can authorize fresh.
    expect(
      await voidStaleAuthorization(
        { firestore: admin().firestore, stripe: fakeStripe() },
        tripRef.id,
      ),
    ).toBe('voided');

    const tripVoided = (await tripRef.get()).data();
    expect(tripVoided?.paymentStatus).toBeNull();
    expect(tripVoided?.paymentIntentId).toBeNull();
    expect(tripVoided?.authorizedAmountMinorUnits).toBeNull();
  });
});
