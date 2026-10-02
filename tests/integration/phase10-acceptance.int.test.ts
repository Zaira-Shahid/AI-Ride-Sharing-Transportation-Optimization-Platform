import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it } from 'vitest';
import { runBatchOptimization } from '../../functions/src/optimizationRun';
import type { PushProvider, SendPushParams } from '../../functions/src/pushProvider';
import type { RoutePoint, RoutingProvider } from '../../functions/src/routing';
import type { StripeProvider } from '../../functions/src/stripeProvider';
import {
  completeDropoff as serverCompleteDropoff,
  headToPickup as serverHeadToPickup,
  startTransit as serverStartTransit,
} from '../../functions/src/tripExecution';
import {
  cancelTripRequest as serverCancelTripRequest,
  createTripRequest as serverCreateTripRequest,
} from '../../functions/src/tripRequests';
import {
  approachDropoff as clientApproachDropoff,
  confirmPickup as clientConfirmPickup,
  declareDestination,
  saveVehicle,
  setAvailability,
  setJourneyDetour,
  setJourneyOrigin,
  setJourneySeats,
  setVehicleCapacity,
} from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail } from './support';

// Phase 10 acceptance (Notifications): the spec gives every other phase its own one-line acceptance
// criterion, but Phase 10's own section has none - just its 7-module list (FCM, push tokens, trip
// notifications, route changes, driver arrival, payment notifications, safety notifications). This
// test's own acceptance bar, in that gap's absence: a real passenger is pushed at every real milestone
// of a real trip's lifecycle (modules 10.1-10.4, 10.6, 10.8), and pre-match cancellation is pushed too
// (10.8) - proving the whole story end to end, not re-testing any one module's own edge cases (those
// already have their own dedicated tests: route changes in availability/routeModification/planInsertion.
// int.test.ts, driver-delayed in location.int.test.ts). Safety notifications (the spec's own Phase 10
// module 7) and payment-failed pushes are both deliberately out of scope, per the user's own standing
// decision (no safety backend, no retry/card-update UI yet).
//
// Driver-side steps this file does NOT assert a push for (confirmPickup/approachDropoff - "passenger
// pickup"/"drop-off changed" were never in scope for any module built) go through the real client
// callables; every step this file DOES assert a push for is called directly against functions/src's own
// exports with a fake PushProvider, so no real Expo network call is ever made - the same approach every
// push module's own dedicated tests already take.

function fakeStripe(overrides: Partial<StripeProvider> = {}): StripeProvider {
  return {
    ping: async () => true,
    createCustomer: async () => 'cus_fake',
    authorizePayment: async () => ({ status: 'authorized', paymentIntentId: 'pi_fake' }),
    capturePayment: async () => ({ status: 'captured' }),
    voidPayment: async () => ({ status: 'voided' }),
    refundPayment: async () => ({ status: 'refunded' }),
    deleteCustomer: async () => ({ status: 'deleted' }),
    verifyWebhookEvent: () => ({ status: 'invalid' }),
    ...overrides,
  };
}

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

function positionalProvider(): RoutingProvider {
  return {
    route: (stops: RoutePoint[]) => {
      let distance = 0;
      for (let i = 1; i < stops.length; i += 1) {
        distance += Math.round(Math.abs(stops[i]!.latitude - stops[i - 1]!.latitude) * 100_000);
      }
      const legs = stops.slice(1).map((_, i) => {
        const d = Math.round(Math.abs(stops[i + 1]!.latitude - stops[i]!.latitude) * 100_000);
        return { distanceMeters: d, durationSeconds: d };
      });
      return Promise.resolve({
        distanceMeters: distance,
        durationSeconds: distance,
        geometry: '_p~iF~ps|U',
        legs,
      });
    },
  };
}

function fakeOptimizationFetch(script: { candidates: unknown; optimize: unknown }): typeof fetch {
  return ((url: string) => {
    const body = url.endsWith('/candidates') ? script.candidates : script.optimize;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

const NO_LIMITS = { globalSpacingMs: 0, perCallerPerMinute: 1_000 };

let counter = 0;

async function driverWithJourney(): Promise<{
  client: ReturnType<typeof createClient>;
  uid: string;
  journeyId: string;
}> {
  counter += 1;
  const at = 30 + counter * 3;
  const client = createClient();
  const { user, uid, email } = await signUp(client, `p10a-d${counter}`);
  await httpsCallable(
    client.functions,
    'completeRegistration',
  )({ role: 'DRIVER', name: 'Test Driver' });
  await verifyEmail(user, email);
  await saveVehicle(client, {
    type: 'CAR',
    make: 'Toyota',
    model: 'Corolla',
    plateNumber: `P10A-${Date.now() % 100000}-${counter}`,
  });
  await setVehicleCapacity(client, 4);
  await admin().firestore.doc(`drivers/${uid}`).update({ verificationStatus: 'VERIFIED' });
  await admin().firestore.doc(`vehicles/${uid}`).update({ verificationStatus: 'VERIFIED' });
  await declareDestination(client, {
    latitude: at + 10,
    longitude: 0,
    formattedAddress: 'Destination',
    placeId: null,
  });
  await setJourneyOrigin(client, { latitude: at, longitude: 0 });
  await setJourneySeats(client, 3);
  await setJourneyDetour(client, 60, 30);
  await setAvailability(client, 'ONLINE');

  const driverDoc = await admin().firestore.doc(`drivers/${uid}`).get();
  const journeyId = driverDoc.get('currentJourneyId') as string;
  return { client, uid, journeyId };
}

async function passenger(prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(
    client.functions,
    'completeRegistration',
  )({ role: 'PASSENGER', name: 'Test Passenger' });
  await verifyEmail(user, email);
  return { client, uid };
}

const tripRequestInput = (origin: RoutePoint, destination: RoutePoint) => ({
  origin: { ...origin, formattedAddress: 'Pickup', placeId: null },
  destination: { ...destination, formattedAddress: 'Destination', placeId: null },
  departure: { kind: 'NOW' as const },
  arriveBy: null,
  preferences: {
    flexibilityLevel: 'FLEXIBLE' as const,
    maxWalkingDistance: 1000,
    maxExtraTime: 20,
    maxDetourDistance: 5,
    allowSharedRide: true,
    allowRouteChange: true,
  },
});

describe('Phase 10 acceptance (functions + firestore emulators)', () => {
  beforeEach(async () => {
    const { firestore } = admin();
    // This file's own runBatchOptimization call reads the WHOLE tripRequests/driverJourneys
    // collections, not scoped to its own fixtures - a SEARCHING request or an AVAILABLE/MATCHING
    // journey some OTHER file left behind (the whole suite shares one long-lived Firestore,
    // fileParallelism: false) can get matched by THIS run, pushing accounts this file never created.
    // Cleared here, not in every file - only the files that run the global batch (this one,
    // optimizationRun/phase6/8-acceptance) can be affected by it.
    for (const name of ['tripRequests', 'driverJourneys']) {
      await firestore.recursiveDelete(firestore.collection(name));
    }
  });

  it('pushes the passenger and driver at every real milestone, from request to payment', async () => {
    const driver = await driverWithJourney();
    const rider = await passenger('p10a-p');
    await admin()
      .firestore.doc(`users/${driver.uid}`)
      .update({ pushToken: 'ExponentPushToken[driver]' });
    await admin()
      .firestore.doc(`users/${rider.uid}`)
      .update({ pushToken: 'ExponentPushToken[passenger]' });

    // Module 10.8: "Trip requested" - far from any driver (Module 5.2's own real proximity check
    // finds nothing here), so the still-active automatic per-request matching (Module 5.5) never
    // races this test's own deliberate batch-optimization call below.
    const requestPush = recordingPush();
    const { tripId } = await serverCreateTripRequest(
      { firestore: admin().firestore, push: requestPush },
      { uid: rider.uid, role: 'PASSENGER', emailVerified: true },
      tripRequestInput({ latitude: -40, longitude: 100 }, { latitude: -39, longitude: 100 }),
    );
    expect(requestPush.sent).toEqual([
      {
        token: 'ExponentPushToken[passenger]',
        title: 'Trip requested',
        body: "We're searching for a driver for you.",
      },
    ]);

    async function waitForSearching(): Promise<void> {
      const stop = Date.now() + 20_000;
      for (;;) {
        const data = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
        if (data?.status === 'SEARCHING') return;
        if (Date.now() > stop) throw new Error('Timed out waiting for SEARCHING.');
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    await waitForSearching();

    // Module 10.3: "Trip matched" (passenger) + "New passenger" (driver) - a scripted batch run, the
    // same approach optimizationRun.int.test.ts takes, so the match is deterministic.
    const matchPush = recordingPush();
    const script = {
      candidates: {
        candidates: [
          {
            request_id: tripId,
            journey_id: driver.journeyId,
            driver_id: driver.uid,
            distance_meters: 1000,
            bearing_difference_degrees: 5,
          },
        ],
      },
      optimize: {
        plans: [
          {
            journey_id: driver.journeyId,
            driver_id: driver.uid,
            stops: [
              { kind: 'pickup', request_id: tripId },
              { kind: 'dropoff', request_id: tripId },
            ],
            request_ids: [tripId],
            dropped_request_ids: [],
            total_distance_meters: 1000,
            total_duration_seconds: 1000,
          },
        ],
        explanations: [
          {
            request_id: tripId,
            status: 'matched',
            journey_id: driver.journeyId,
            reason: 'matched',
          },
        ],
        validation_issues: [],
        summary: {
          requested_count: 1,
          matched_count: 1,
          dropped_after_sharing_count: 0,
          unmatched_count: 0,
          unmatched_by_reason: {},
          journeys_used: 1,
          total_distance_meters: 1000,
          total_duration_seconds: 1000,
          validation_issue_count: 0,
          run_duration_seconds: 0.01,
        },
      },
    };
    await runBatchOptimization({
      firestore: admin().firestore,
      provider: positionalProvider(),
      limits: NO_LIMITS,
      optimizationService: {
        baseUrl: 'https://opt.example',
        fetchImpl: fakeOptimizationFetch(script),
      },
      push: matchPush,
    });
    expect(matchPush.sent).toHaveLength(2);
    expect(matchPush.sent).toContainEqual({
      token: 'ExponentPushToken[driver]',
      title: 'New passenger',
      body: "You've been matched with 1 passenger.",
    });
    expect(matchPush.sent).toContainEqual({
      token: 'ExponentPushToken[passenger]',
      title: 'Trip matched',
      body: "You've been matched with a driver.",
    });
    expect((await admin().firestore.doc(`tripRequests/${tripId}`).get()).data()?.status).toBe(
      'PICKUP_ASSIGNED',
    );

    // Module 10.6: "Driver arriving" (passenger).
    const arrivingPush = recordingPush();
    const driverCaller = { uid: driver.uid, role: 'DRIVER', emailVerified: true };
    await serverHeadToPickup({ firestore: admin().firestore, push: arrivingPush }, driverCaller, {
      tripId,
    });
    expect(arrivingPush.sent).toEqual([
      {
        token: 'ExponentPushToken[passenger]',
        title: 'Driver arriving',
        body: 'Your driver is on the way to pick you up.',
      },
    ]);

    // "Passenger pickup" was never in scope for any module built - no push asserted here, the real
    // client callable is used like any other untouched step.
    expect(await clientConfirmPickup(driver.client, tripId)).toBe('updated');

    // Module 10.8: "Trip started" (passenger).
    const startedPush = recordingPush();
    await serverStartTransit({ firestore: admin().firestore, push: startedPush }, driverCaller, {
      tripId,
    });
    expect(startedPush.sent).toEqual([
      {
        token: 'ExponentPushToken[passenger]',
        title: 'Trip started',
        body: 'Your trip has started.',
      },
    ]);

    // "Drop-off changed" was never in scope for any module built - no push asserted here.
    expect(await clientApproachDropoff(driver.client, tripId)).toBe('updated');

    // Modules 9.2-9.4's own fare fields, set directly the same way phase9-acceptance.int.test.ts
    // does - this file is about notifications, not re-proving fare calculation.
    await admin().firestore.doc(`tripRequests/${tripId}`).update({
      paymentIntentId: 'pi_fixture',
      paymentStatus: 'AUTHORIZED',
      estimatedDistance: 5_000,
      estimatedDuration: 600,
    });

    // Module 10.8: "Trip completed" (passenger, from advance() itself) + Module 10.4: "Payment
    // captured" (passenger) and "You got paid" (driver) - "Trip completed" is always first (advance()
    // resolves and sends its own push before captureTripPayment is even called; the other two are
    // sent concurrently via Promise.all, so order between them is not guaranteed).
    const completedPush = recordingPush();
    const completeResult = await serverCompleteDropoff(
      { firestore: admin().firestore, stripe: fakeStripe(), push: completedPush },
      driverCaller,
      { tripId },
    );
    expect(completeResult.status).toBe('updated');
    expect(completedPush.sent[0]).toEqual({
      token: 'ExponentPushToken[passenger]',
      title: 'Trip completed',
      body: 'Your trip is complete. Thanks for riding with us.',
    });
    expect(completedPush.sent).toHaveLength(3);
    expect(completedPush.sent).toContainEqual({
      token: 'ExponentPushToken[passenger]',
      title: 'Payment captured',
      body: 'You were charged $10.00 for your trip.',
    });
    expect(completedPush.sent).toContainEqual({
      token: 'ExponentPushToken[driver]',
      title: 'You got paid',
      body: 'You earned $8.00 for this trip.',
    });

    expect((await admin().firestore.doc(`tripRequests/${tripId}`).get()).data()?.status).toBe(
      'COMPLETED',
    );
  }, 60_000);

  it('pushes a self-confirmation on request and on a pre-match cancellation', async () => {
    const rider = await passenger('p10a-cancel');
    await admin()
      .firestore.doc(`users/${rider.uid}`)
      .update({ pushToken: 'ExponentPushToken[passenger]' });
    const passengerCaller = { uid: rider.uid, role: 'PASSENGER', emailVerified: true };

    const requestPush = recordingPush();
    const { tripId } = await serverCreateTripRequest(
      { firestore: admin().firestore, push: requestPush },
      passengerCaller,
      tripRequestInput({ latitude: -41, longitude: 101 }, { latitude: -40, longitude: 101 }),
    );
    expect(requestPush.sent).toEqual([
      {
        token: 'ExponentPushToken[passenger]',
        title: 'Trip requested',
        body: "We're searching for a driver for you.",
      },
    ]);

    const cancelPush = recordingPush();
    const result = await serverCancelTripRequest(
      { firestore: admin().firestore, push: cancelPush },
      passengerCaller,
      { tripId },
    );
    expect(result).toEqual({ status: 'cancelled' });
    expect(cancelPush.sent).toEqual([
      {
        token: 'ExponentPushToken[passenger]',
        title: 'Trip cancelled',
        body: 'Your ride request has been cancelled.',
      },
    ]);
  });
});
