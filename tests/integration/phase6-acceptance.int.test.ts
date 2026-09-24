import { httpsCallable } from 'firebase/functions';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTripRequest,
  declareDestination,
  saveVehicle,
  setAvailability,
  setJourneyDetour,
  setJourneyOrigin,
  setJourneySeats,
  setVehicleCapacity,
} from '../../packages/firebase/src';
import { runBatchOptimization } from '../../functions/src/optimizationRun';
import { claimImmediateOptimizationRun } from '../../functions/src/optimizationTrigger';
import { createOsrmProvider, type RoutingProvider } from '../../functions/src/routing';
import { FAKE_OSRM_BASE_PATH, FAKE_OSRM_PORT, startFakeOsrm, type FakeOsrm } from '../fake-osrm';
import { startOptimizationService, type OptimizationService } from '../optimization-service';
import { admin, createClient, signUp, verifyEmail } from './support';

// Phase 6 acceptance ("the system can pool passengers into shared journeys"): the one test in the
// whole suite that starts the REAL Python optimization service (services/optimization/app) as a real
// subprocess, rather than a scripted fetchImpl standing in for it (as optimizationRun.int.test.ts
// does) - so this is the only automated check that the HTTP boundary between the two languages, and
// the Python service's own OR-Tools model, actually work together, not just the TS orchestration
// around them. Routing still goes through the fake OSRM every other integration test uses (module
// 4.3's own real-network behaviour is that module's job to verify, not this one's) so the test stays
// fast and deterministic; only the optimization service itself is real.

const NO_LIMITS = { globalSpacingMs: 0, perCallerPerMinute: 1_000 };

// Its own corner of the world, away from every other integration test file's coordinates, so no
// leftover driver or request from another file is ever a candidate here.
const ORIGIN = { latitude: 64, longitude: -8 };
const DESTINATION = { latitude: 64.05, longitude: -7.95 };
const PICKUP = { latitude: 64.005, longitude: -7.995 };

const place = (point: { latitude: number; longitude: number }, address: string) => ({
  ...point,
  formattedAddress: address,
  placeId: null,
});

// The exact numbers module 3.6 fixed for BALANCED - isValidFlexibilityPreferences refuses anything
// else for this level, however reasonable it looks.
const BALANCED = {
  flexibilityLevel: 'BALANCED' as const,
  maxWalkingDistance: 500,
  maxExtraTime: 10,
  maxDetourDistance: 3,
  allowSharedRide: true,
  allowRouteChange: true,
};

let fake: FakeOsrm;
let optimizationService: OptimizationService;
let provider: RoutingProvider;

beforeAll(async () => {
  fake = await startFakeOsrm();
  optimizationService = await startOptimizationService();
  // Built explicitly, not osrmFromEnvironment(): this test process is vitest itself, not the
  // Functions emulator, so it never sees functions/.env.demo-ridemesh's ROUTING_BASE_URL_DRIVING -
  // the same reason matching.int.test.ts's own direct assignSearchingTripRequest call does this too.
  provider = createOsrmProvider({
    baseUrls: {
      driving: `http://127.0.0.1:${FAKE_OSRM_PORT}${FAKE_OSRM_BASE_PATH}`,
      walking: '',
    },
    userAgent: 'RideMesh-tests',
  });
}, 30_000);

afterAll(async () => {
  await fake.close();
  await optimizationService.close();
});

beforeEach(async () => {
  const { firestore } = admin();
  for (const name of ['routeCache', 'routeLimits', 'routeGlobal']) {
    await firestore.recursiveDelete(firestore.collection(name));
  }
  fake.requests.length = 0;
  fake.reply(null);
});

async function onlineDriver(prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(
    client.functions,
    'completeRegistration',
  )({ role: 'DRIVER', name: 'Test Driver' });
  await verifyEmail(user, email);
  await saveVehicle(client, {
    type: 'CAR',
    make: 'Toyota',
    model: 'Corolla',
    plateNumber: `P6A-${Date.now() % 100000}`,
  });
  await setVehicleCapacity(client, 4);
  await admin().firestore.doc(`drivers/${uid}`).update({ verificationStatus: 'VERIFIED' });
  await admin().firestore.doc(`vehicles/${uid}`).update({ verificationStatus: 'VERIFIED' });
  await declareDestination(client, place(DESTINATION, 'Destination'));
  await setJourneyOrigin(client, ORIGIN);
  await setJourneySeats(client, 3);
  await setJourneyDetour(client, 15, 5);
  await setAvailability(client, 'ONLINE');
  return { client, uid };
}

async function searchingPassenger(prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(
    client.functions,
    'completeRegistration',
  )({ role: 'PASSENGER', name: 'Test Passenger' });
  await verifyEmail(user, email);

  const tripId = await createTripRequest(client, {
    origin: place(PICKUP, 'Pickup'),
    destination: place(DESTINATION, 'Destination'),
    departure: { kind: 'NOW' },
    arriveBy: null,
    preferences: BALANCED,
  });

  // This test wants sole control of when the real optimization service is called (Module 8.1/8.2's
  // own immediate trigger would otherwise race it, reacting to this same request reaching SEARCHING a
  // moment from now - with the real service actually listening for the length of this whole
  // describe block, unlike every other integration test, where it silently does nothing). Claiming
  // the debounce window first, before that happens, makes the automatic trigger back off.
  await claimImmediateOptimizationRun({ firestore: admin().firestore });

  const stop = Date.now() + 20_000;
  for (;;) {
    const data = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    if (data?.status === 'SEARCHING') break;
    if (Date.now() > stop) throw new Error('Timed out waiting for SEARCHING.');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return { uid, tripId };
}

describe('Phase 6 acceptance (functions + firestore emulators, the real optimization service)', () => {
  it('pools a nearby, compatible passenger onto a driver journey using the real service', async () => {
    const driver = await onlineDriver('p6a-driver');
    const { tripId } = await searchingPassenger('p6a-passenger');

    const outcome = await runBatchOptimization({
      firestore: admin().firestore,
      provider,
      optimizationService: { baseUrl: optimizationService.baseUrl },
      limits: NO_LIMITS,
    });

    // Other integration test files leave their own SEARCHING requests and AVAILABLE journeys behind
    // in the same shared emulator run (see matching.int.test.ts's own note on this), and the REAL
    // optimization service - unlike a scripted one - actually looks at all of them, so it may pool in
    // matches that have nothing to do with this test. Only this test's own request is checked
    // specifically below; the aggregate count is not.
    expect(outcome.matchedRequestCount).toBeGreaterThanOrEqual(1);
    expect(outcome.matchedJourneyCount).toBeGreaterThanOrEqual(1);

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('PICKUP_ASSIGNED');
    expect(trip?.matchedDriverId).toBe(driver.uid);
    expect(typeof trip?.assignedPlanId).toBe('string');

    const journey = (
      await admin().firestore.doc(`driverJourneys/${trip?.matchedJourneyId}`).get()
    ).data();
    expect(journey?.status).toBe('MATCHING');
    expect(journey?.matchedTripRequestIds).toEqual([tripId]);

    const plan = (
      await admin()
        .firestore.doc(`journeyPlans/${trip?.assignedPlanId as string}`)
        .get()
    ).data();
    expect(plan?.requestIds).toEqual([tripId]);
    expect(plan?.stops).toEqual([
      { kind: 'pickup', requestId: tripId },
      { kind: 'dropoff', requestId: tripId },
    ]);
    // Real OR-Tools output, not a script: only a sensible positive number is asserted.
    expect(plan?.totalDistanceMeters).toBeGreaterThan(0);
    expect(plan?.totalDurationSeconds).toBeGreaterThan(0);
  });

  it('matches nothing for a request nobody is near, even through the real service', async () => {
    const { tripId } = await searchingPassenger('p6a-alone');

    // The aggregate outcome is not asserted here, for the same reason as the test above: other
    // integration test files' own leftover SEARCHING requests and AVAILABLE journeys are real
    // Firestore state the real service also sees. Only this specific request is checked.
    await runBatchOptimization({
      firestore: admin().firestore,
      provider,
      optimizationService: { baseUrl: optimizationService.baseUrl },
      limits: NO_LIMITS,
    });

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('SEARCHING');
    expect(trip?.matchedJourneyId).toBeNull();
  });
});
