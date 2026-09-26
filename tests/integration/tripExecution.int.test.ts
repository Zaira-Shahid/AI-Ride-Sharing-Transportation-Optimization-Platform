import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import { completeDropoff as driverCompleteDropoff } from '../../functions/src/tripExecution';
import type { StripeProvider } from '../../functions/src/stripeProvider';
import { admin, createClient, signUp, verifyEmail } from './support';

// Module 7.2: headToPickup (PICKUP_ASSIGNED -> DRIVER_ARRIVING) and confirmPickup (DRIVER_ARRIVING ->
// PICKED_UP). Module 7.4 adds startTransit (PICKED_UP -> IN_TRANSIT), stop-order enforcement for the
// pickup actions, and the journey's own MATCHING -> ACTIVE move on the first confirmed pickup. Module
// 7.5 adds approachDropoff (IN_TRANSIT -> DROPOFF_APPROACHING) and completeDropoff
// (DROPOFF_APPROACHING -> COMPLETED), widens stop-order enforcement to cover dropoff stops too, clears
// the passenger's own open-request pointer on completion, and completes the JOURNEY (freeing the
// driver's currentJourneyId) once every matched request is COMPLETED. All actions are manual driver
// actions. A request is faked straight into the status under test via the admin SDK (bypassing the
// whole matching/optimization pipeline, which has its own tests) so this file is only about the
// callables' own rules: who may call them, from which status, and that a repeat call is harmless.

const PLACE = { latitude: 51.5, longitude: -0.1, formattedAddress: 'A place', placeId: null };

async function person(role: 'DRIVER' | 'PASSENGER', prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
  await verifyEmail(user, email);
  const call = (name: string, data: unknown) => httpsCallable(client.functions, name)(data);
  return { client, uid, call };
}

/** A tripRequests fixture at `status`, matched to `driverId` (or nobody, when null). */
async function tripAt(
  status: string,
  driverId: string | null,
  extra: {
    journeyId?: string;
    assignedPlanId?: string;
    passengerId?: string;
    estimatedDistance?: number;
    estimatedDuration?: number;
    sharedRide?: boolean;
  } = {},
) {
  const ref = admin().firestore.collection('tripRequests').doc();
  await ref.set({
    passengerId: extra.passengerId ?? 'passenger-fixture',
    passengerName: 'Pat',
    origin: PLACE,
    destination: PLACE,
    status,
    matchedDriverId: driverId,
    matchedJourneyId: driverId ? (extra.journeyId ?? 'journey-fixture') : null,
    assignedPlanId: extra.assignedPlanId ?? null,
    estimatedDistance: extra.estimatedDistance ?? null,
    estimatedDuration: extra.estimatedDuration ?? null,
    sharedRide: extra.sharedRide ?? false,
    finalFareMinorUnits: null,
    platformFeeMinorUnits: null,
  });
  return ref.id;
}

/** The reason the server gave for a refusal, or the error code when it gave none. */
async function refusal(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    const { details, code } = error as { details?: { reason?: string }; code?: string };
    return details?.reason ?? code?.replace('functions/', '') ?? 'unknown';
  }
  return 'none';
}

describe('headToPickup (functions + firestore emulators)', () => {
  it('moves the matched driver own request from PICKUP_ASSIGNED to DRIVER_ARRIVING', async () => {
    const driver = await person('DRIVER', 'head-ok');
    const tripId = await tripAt('PICKUP_ASSIGNED', driver.uid);

    const result = await driver.call('headToPickup', { tripId });
    expect((result.data as { status: string }).status).toBe('updated');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('DRIVER_ARRIVING');
  });

  it('is unchanged, not an error, when already DRIVER_ARRIVING', async () => {
    const driver = await person('DRIVER', 'head-again');
    const tripId = await tripAt('DRIVER_ARRIVING', driver.uid);

    const result = await driver.call('headToPickup', { tripId });
    expect((result.data as { status: string }).status).toBe('unchanged');
  });

  it('refuses a status other than PICKUP_ASSIGNED or DRIVER_ARRIVING', async () => {
    const driver = await person('DRIVER', 'head-wrong');
    const tripId = await tripAt('SEARCHING', driver.uid);

    expect(await refusal(driver.call('headToPickup', { tripId }))).toBe('WRONG_STATUS');
    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('SEARCHING');
  });

  it("reports someone else's request, or a missing one, as not found", async () => {
    const driver = await person('DRIVER', 'head-owner');
    const other = await person('DRIVER', 'head-other');
    const tripId = await tripAt('PICKUP_ASSIGNED', driver.uid);

    expect(await refusal(other.call('headToPickup', { tripId }))).toBe('NOT_FOUND');
    expect(await refusal(other.call('headToPickup', { tripId: 'does-not-exist' }))).toBe(
      'NOT_FOUND',
    );

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('PICKUP_ASSIGNED');
  });

  it('refuses a passenger caller', async () => {
    const driver = await person('DRIVER', 'head-role-d');
    const passenger = await person('PASSENGER', 'head-role-p');
    const tripId = await tripAt('PICKUP_ASSIGNED', driver.uid);

    expect(await refusal(passenger.call('headToPickup', { tripId }))).toBe('permission-denied');
  });
});

describe('confirmPickup (functions + firestore emulators)', () => {
  it('moves the matched driver own request from DRIVER_ARRIVING to PICKED_UP', async () => {
    const driver = await person('DRIVER', 'confirm-ok');
    const tripId = await tripAt('DRIVER_ARRIVING', driver.uid);

    const result = await driver.call('confirmPickup', { tripId });
    expect((result.data as { status: string }).status).toBe('updated');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('PICKED_UP');
  });

  it('is unchanged, not an error, when already PICKED_UP', async () => {
    const driver = await person('DRIVER', 'confirm-again');
    const tripId = await tripAt('PICKED_UP', driver.uid);

    const result = await driver.call('confirmPickup', { tripId });
    expect((result.data as { status: string }).status).toBe('unchanged');
  });

  it('refuses a request still only PICKUP_ASSIGNED (must head to pickup first)', async () => {
    const driver = await person('DRIVER', 'confirm-early');
    const tripId = await tripAt('PICKUP_ASSIGNED', driver.uid);

    expect(await refusal(driver.call('confirmPickup', { tripId }))).toBe('WRONG_STATUS');
  });

  it("reports someone else's request as not found", async () => {
    const driver = await person('DRIVER', 'confirm-owner');
    const other = await person('DRIVER', 'confirm-other');
    const tripId = await tripAt('DRIVER_ARRIVING', driver.uid);

    expect(await refusal(other.call('confirmPickup', { tripId }))).toBe('NOT_FOUND');
  });

  it('moves the journey from MATCHING to ACTIVE on the first confirmed pickup', async () => {
    const driver = await person('DRIVER', 'confirm-activate');
    const journeyRef = admin().firestore.collection('driverJourneys').doc();
    await journeyRef.set({ driverId: driver.uid, status: 'MATCHING' });
    const tripId = await tripAt('DRIVER_ARRIVING', driver.uid, { journeyId: journeyRef.id });

    await driver.call('confirmPickup', { tripId });

    expect((await journeyRef.get()).data()?.status).toBe('ACTIVE');
  });

  it('leaves an already-ACTIVE journey alone (second passenger picked up)', async () => {
    const driver = await person('DRIVER', 'confirm-already-active');
    const journeyRef = admin().firestore.collection('driverJourneys').doc();
    await journeyRef.set({ driverId: driver.uid, status: 'ACTIVE' });
    const tripId = await tripAt('DRIVER_ARRIVING', driver.uid, { journeyId: journeyRef.id });

    await driver.call('confirmPickup', { tripId });

    expect((await journeyRef.get()).data()?.status).toBe('ACTIVE');
  });
});

describe('startTransit (functions + firestore emulators)', () => {
  it('moves the matched driver own request from PICKED_UP to IN_TRANSIT', async () => {
    const driver = await person('DRIVER', 'transit-ok');
    const tripId = await tripAt('PICKED_UP', driver.uid);

    const result = await driver.call('startTransit', { tripId });
    expect((result.data as { status: string }).status).toBe('updated');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('IN_TRANSIT');
  });

  it('is unchanged, not an error, when already IN_TRANSIT', async () => {
    const driver = await person('DRIVER', 'transit-again');
    const tripId = await tripAt('IN_TRANSIT', driver.uid);

    const result = await driver.call('startTransit', { tripId });
    expect((result.data as { status: string }).status).toBe('unchanged');
  });

  it('refuses a request still only DRIVER_ARRIVING (must confirm pickup first)', async () => {
    const driver = await person('DRIVER', 'transit-early');
    const tripId = await tripAt('DRIVER_ARRIVING', driver.uid);

    expect(await refusal(driver.call('startTransit', { tripId }))).toBe('WRONG_STATUS');
  });

  it("reports someone else's request as not found", async () => {
    const driver = await person('DRIVER', 'transit-owner');
    const other = await person('DRIVER', 'transit-other');
    const tripId = await tripAt('PICKED_UP', driver.uid);

    expect(await refusal(other.call('startTransit', { tripId }))).toBe('NOT_FOUND');
  });
});

describe('stop-order enforcement (Module 7.4, functions + firestore emulators)', () => {
  it('refuses headToPickup for a later pickup stop while an earlier one is still pending', async () => {
    const driver = await person('DRIVER', 'order-head');
    const first = await tripAt('PICKUP_ASSIGNED', driver.uid, { journeyId: 'journey-order-1' });
    const second = await tripAt('PICKUP_ASSIGNED', driver.uid, { journeyId: 'journey-order-1' });
    const planRef = admin().firestore.collection('journeyPlans').doc();
    await planRef.set({
      journeyId: 'journey-order-1',
      driverId: driver.uid,
      stops: [
        { kind: 'pickup', requestId: first },
        { kind: 'pickup', requestId: second },
        { kind: 'dropoff', requestId: first },
        { kind: 'dropoff', requestId: second },
      ],
    });
    await admin().firestore.doc(`tripRequests/${first}`).update({ assignedPlanId: planRef.id });
    await admin().firestore.doc(`tripRequests/${second}`).update({ assignedPlanId: planRef.id });

    // The later stop (second) is refused while the earlier one (first) has not reached it yet.
    expect(await refusal(driver.call('headToPickup', { tripId: second }))).toBe('WRONG_STATUS');
    expect((await admin().firestore.doc(`tripRequests/${second}`).get()).data()?.status).toBe(
      'PICKUP_ASSIGNED',
    );

    // The earlier stop is unaffected and can proceed.
    const firstResult = await driver.call('headToPickup', { tripId: first });
    expect((firstResult.data as { status: string }).status).toBe('updated');

    // Once the earlier pickup has actually been completed (PICKED_UP), the later one is free.
    await admin().firestore.doc(`tripRequests/${first}`).update({ status: 'PICKED_UP' });
    const secondResult = await driver.call('headToPickup', { tripId: second });
    expect((secondResult.data as { status: string }).status).toBe('updated');
  });

  it('never blocks startTransit on plan order (a picked-up passenger cannot jump ahead)', async () => {
    const driver = await person('DRIVER', 'order-transit');
    const first = await tripAt('PICKUP_ASSIGNED', driver.uid, { journeyId: 'journey-order-2' });
    const second = await tripAt('PICKED_UP', driver.uid, { journeyId: 'journey-order-2' });
    const planRef = admin().firestore.collection('journeyPlans').doc();
    await planRef.set({
      journeyId: 'journey-order-2',
      driverId: driver.uid,
      stops: [
        { kind: 'pickup', requestId: first },
        { kind: 'pickup', requestId: second },
      ],
    });
    await admin().firestore.doc(`tripRequests/${second}`).update({ assignedPlanId: planRef.id });

    const result = await driver.call('startTransit', { tripId: second });
    expect((result.data as { status: string }).status).toBe('updated');
  });

  it('refuses a later pickup stop while an earlier DROPOFF stop is still pending (Module 7.5)', async () => {
    const driver = await person('DRIVER', 'order-dropoff-blocks-pickup');
    const first = await tripAt('DROPOFF_APPROACHING', driver.uid, {
      journeyId: 'journey-order-3',
    });
    const second = await tripAt('PICKUP_ASSIGNED', driver.uid, { journeyId: 'journey-order-3' });
    const planRef = admin().firestore.collection('journeyPlans').doc();
    await planRef.set({
      journeyId: 'journey-order-3',
      driverId: driver.uid,
      stops: [
        { kind: 'dropoff', requestId: first },
        { kind: 'pickup', requestId: second },
      ],
    });
    await admin().firestore.doc(`tripRequests/${second}`).update({ assignedPlanId: planRef.id });

    expect(await refusal(driver.call('headToPickup', { tripId: second }))).toBe('WRONG_STATUS');
  });
});

describe('approachDropoff (functions + firestore emulators)', () => {
  it('moves the matched driver own request from IN_TRANSIT to DROPOFF_APPROACHING', async () => {
    const driver = await person('DRIVER', 'approach-ok');
    const tripId = await tripAt('IN_TRANSIT', driver.uid);

    const result = await driver.call('approachDropoff', { tripId });
    expect((result.data as { status: string }).status).toBe('updated');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('DROPOFF_APPROACHING');
  });

  it('is unchanged, not an error, when already DROPOFF_APPROACHING', async () => {
    const driver = await person('DRIVER', 'approach-again');
    const tripId = await tripAt('DROPOFF_APPROACHING', driver.uid);

    const result = await driver.call('approachDropoff', { tripId });
    expect((result.data as { status: string }).status).toBe('unchanged');
  });

  it('refuses a request still only PICKED_UP (must start the trip first)', async () => {
    const driver = await person('DRIVER', 'approach-early');
    const tripId = await tripAt('PICKED_UP', driver.uid);

    expect(await refusal(driver.call('approachDropoff', { tripId }))).toBe('WRONG_STATUS');
  });

  it("reports someone else's request as not found", async () => {
    const driver = await person('DRIVER', 'approach-owner');
    const other = await person('DRIVER', 'approach-other');
    const tripId = await tripAt('IN_TRANSIT', driver.uid);

    expect(await refusal(other.call('approachDropoff', { tripId }))).toBe('NOT_FOUND');
  });

  it('refuses a dropoff stop while an earlier one in the plan is still pending', async () => {
    const driver = await person('DRIVER', 'approach-order');
    const first = await tripAt('IN_TRANSIT', driver.uid, { journeyId: 'journey-order-4' });
    const second = await tripAt('IN_TRANSIT', driver.uid, { journeyId: 'journey-order-4' });
    const planRef = admin().firestore.collection('journeyPlans').doc();
    await planRef.set({
      journeyId: 'journey-order-4',
      driverId: driver.uid,
      stops: [
        { kind: 'dropoff', requestId: first },
        { kind: 'dropoff', requestId: second },
      ],
    });
    await admin().firestore.doc(`tripRequests/${first}`).update({ assignedPlanId: planRef.id });
    await admin().firestore.doc(`tripRequests/${second}`).update({ assignedPlanId: planRef.id });

    expect(await refusal(driver.call('approachDropoff', { tripId: second }))).toBe('WRONG_STATUS');
  });
});

describe('completeDropoff (functions + firestore emulators)', () => {
  it('moves the matched driver own request from DROPOFF_APPROACHING to COMPLETED', async () => {
    const driver = await person('DRIVER', 'complete-ok');
    const tripId = await tripAt('DROPOFF_APPROACHING', driver.uid);

    const result = await driver.call('completeDropoff', { tripId });
    expect((result.data as { status: string }).status).toBe('updated');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('COMPLETED');
  });

  it('is unchanged, not an error, when already COMPLETED', async () => {
    const driver = await person('DRIVER', 'complete-again');
    const tripId = await tripAt('COMPLETED', driver.uid);

    const result = await driver.call('completeDropoff', { tripId });
    expect((result.data as { status: string }).status).toBe('unchanged');
  });

  it('refuses a request still only IN_TRANSIT (must approach drop-off first)', async () => {
    const driver = await person('DRIVER', 'complete-early');
    const tripId = await tripAt('IN_TRANSIT', driver.uid);

    expect(await refusal(driver.call('completeDropoff', { tripId }))).toBe('WRONG_STATUS');
  });

  it("reports someone else's request as not found", async () => {
    const driver = await person('DRIVER', 'complete-owner');
    const other = await person('DRIVER', 'complete-other');
    const tripId = await tripAt('DROPOFF_APPROACHING', driver.uid);

    expect(await refusal(other.call('completeDropoff', { tripId }))).toBe('NOT_FOUND');
  });

  it('clears the passenger own currentTripRequestId when it still points here (Module 7.5)', async () => {
    const driver = await person('DRIVER', 'complete-clears-passenger');
    const passenger = await person('PASSENGER', 'complete-clears-passenger-p');
    const tripId = await tripAt('DROPOFF_APPROACHING', driver.uid, { passengerId: passenger.uid });
    await admin().firestore.doc(`users/${passenger.uid}`).update({ currentTripRequestId: tripId });

    await driver.call('completeDropoff', { tripId });

    const user = (await admin().firestore.doc(`users/${passenger.uid}`).get()).data();
    expect(user?.currentTripRequestId).toBeNull();
  });

  it("leaves the passenger's pointer alone when it already moved on to a newer request", async () => {
    const driver = await person('DRIVER', 'complete-keeps-newer-passenger');
    const passenger = await person('PASSENGER', 'complete-keeps-newer-passenger-p');
    const tripId = await tripAt('DROPOFF_APPROACHING', driver.uid, { passengerId: passenger.uid });
    await admin()
      .firestore.doc(`users/${passenger.uid}`)
      .update({ currentTripRequestId: 'some-newer-request' });

    await driver.call('completeDropoff', { tripId });

    const user = (await admin().firestore.doc(`users/${passenger.uid}`).get()).data();
    expect(user?.currentTripRequestId).toBe('some-newer-request');
  });

  it('completes the journey and frees the driver once every matched request is COMPLETED', async () => {
    const driver = await person('DRIVER', 'complete-finishes-journey');
    const journeyRef = admin().firestore.collection('driverJourneys').doc();
    const first = await tripAt('DROPOFF_APPROACHING', driver.uid, { journeyId: journeyRef.id });
    const second = await tripAt('COMPLETED', driver.uid, { journeyId: journeyRef.id });
    await journeyRef.set({
      driverId: driver.uid,
      status: 'ACTIVE',
      matchedTripRequestIds: [first, second],
    });
    await admin()
      .firestore.doc(`drivers/${driver.uid}`)
      .update({ currentJourneyId: journeyRef.id });

    await driver.call('completeDropoff', { tripId: first });

    expect((await journeyRef.get()).data()?.status).toBe('COMPLETED');
    const driverDoc = (await admin().firestore.doc(`drivers/${driver.uid}`).get()).data();
    expect(driverDoc?.currentJourneyId).toBeNull();
  });

  it('leaves the journey alone while another matched request is still open', async () => {
    const driver = await person('DRIVER', 'complete-journey-not-yet');
    const journeyRef = admin().firestore.collection('driverJourneys').doc();
    const first = await tripAt('DROPOFF_APPROACHING', driver.uid, { journeyId: journeyRef.id });
    const second = await tripAt('IN_TRANSIT', driver.uid, { journeyId: journeyRef.id });
    await journeyRef.set({
      driverId: driver.uid,
      status: 'ACTIVE',
      matchedTripRequestIds: [first, second],
    });
    await admin()
      .firestore.doc(`drivers/${driver.uid}`)
      .update({ currentJourneyId: journeyRef.id });

    await driver.call('completeDropoff', { tripId: first });

    expect((await journeyRef.get()).data()?.status).toBe('ACTIVE');
    const driverDoc = (await admin().firestore.doc(`drivers/${driver.uid}`).get()).data();
    expect(driverDoc?.currentJourneyId).toBe(journeyRef.id);
  });

  describe('fare finalization (Module 9.3)', () => {
    it('computes the plain fare (no discount) for a solo ride, using the default fare config', async () => {
      const driver = await person('DRIVER', 'complete-fare-solo');
      const tripId = await tripAt('DROPOFF_APPROACHING', driver.uid, {
        estimatedDistance: 5_000,
        estimatedDuration: 600,
        sharedRide: false,
      });

      await driver.call('completeDropoff', { tripId });

      // Default config: 250 + 120*5 + 15*10 = 1000; platform fee 20% of 1000 = 200.
      const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
      expect(trip?.finalFareMinorUnits).toBe(1_000);
      expect(trip?.platformFeeMinorUnits).toBe(200);
    });

    it('discounts the whole fare when the trip was a shared ride', async () => {
      const driver = await person('DRIVER', 'complete-fare-shared');
      const tripId = await tripAt('DROPOFF_APPROACHING', driver.uid, {
        estimatedDistance: 5_000,
        estimatedDuration: 600,
        sharedRide: true,
      });

      await driver.call('completeDropoff', { tripId });

      // 1000 fare, 20% shared-ride discount -> 800; platform fee 20% of 800 = 160.
      const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
      expect(trip?.finalFareMinorUnits).toBe(800);
      expect(trip?.platformFeeMinorUnits).toBe(160);
    });

    it('leaves the fare fields null when no route estimate exists', async () => {
      const driver = await person('DRIVER', 'complete-fare-missing');
      const tripId = await tripAt('DROPOFF_APPROACHING', driver.uid);

      await driver.call('completeDropoff', { tripId });

      const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
      expect(trip?.finalFareMinorUnits).toBeNull();
      expect(trip?.platformFeeMinorUnits).toBeNull();
    });
  });

  describe('payment capture (Module 9.4)', () => {
    // completeDropoff itself is called directly here (not through the httpsCallable, which never
    // gets a fake stripe - the real callable's own env-var check is covered separately below) so a
    // fake StripeProvider can be injected, the same "call the function directly" approach
    // paymentAuthorization.int.test.ts and paymentCapture.int.test.ts already take.
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

    it('captures the held payment right after a real completion', async () => {
      const driver = await person('DRIVER', 'complete-capture-ok');
      const tripId = await tripAt('DROPOFF_APPROACHING', driver.uid);
      await admin().firestore.doc(`tripRequests/${tripId}`).update({
        paymentIntentId: 'pi_fixture',
        paymentStatus: 'AUTHORIZED',
        estimatedDistance: 5_000,
        estimatedDuration: 600,
      });
      let capturedAmount: number | null = null;
      const stripe = fakeStripe({
        capturePayment: async (params) => {
          capturedAmount = params.amountMinorUnits;
          return { status: 'captured' };
        },
      });

      const result = await driverCompleteDropoff(
        { firestore: admin().firestore, stripe },
        { uid: driver.uid, role: 'DRIVER', emailVerified: true },
        { tripId },
      );

      expect(result.status).toBe('updated');
      expect(capturedAmount).toBe(1_000);
      const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
      expect(trip?.paymentStatus).toBe('CAPTURED');
    });

    it('never attempts a capture on an idempotent retry (already COMPLETED)', async () => {
      const driver = await person('DRIVER', 'complete-capture-retry');
      const tripId = await tripAt('COMPLETED', driver.uid);
      await admin().firestore.doc(`tripRequests/${tripId}`).update({
        paymentIntentId: 'pi_fixture',
        paymentStatus: 'AUTHORIZED',
      });
      let calls = 0;
      const stripe = fakeStripe({
        capturePayment: async () => {
          calls += 1;
          return { status: 'captured' };
        },
      });

      const result = await driverCompleteDropoff(
        { firestore: admin().firestore, stripe },
        { uid: driver.uid, role: 'DRIVER', emailVerified: true },
        { tripId },
      );

      expect(result.status).toBe('unchanged');
      expect(calls).toBe(0);
    });

    it('leaves the trip AUTHORIZED, never attempting a capture, when Stripe is not configured', async () => {
      const driver = await person('DRIVER', 'complete-capture-noconfig');
      const tripId = await tripAt('DROPOFF_APPROACHING', driver.uid);
      await admin().firestore.doc(`tripRequests/${tripId}`).update({
        paymentIntentId: 'pi_fixture',
        paymentStatus: 'AUTHORIZED',
      });

      // The real callable never gets a stripe provider without STRIPE_SECRET_KEY set (Module 9.1's
      // own scaffolding-only decision) - the same real path a driver's app actually goes through.
      await driver.call('completeDropoff', { tripId });

      const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
      expect(trip?.status).toBe('COMPLETED');
      expect(trip?.paymentStatus).toBe('AUTHORIZED');
    });
  });
});
