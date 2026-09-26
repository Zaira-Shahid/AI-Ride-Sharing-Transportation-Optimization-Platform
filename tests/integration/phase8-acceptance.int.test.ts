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
  updateDriverLocation,
} from '../../packages/firebase/src';
import { runBatchOptimization } from '../../functions/src/optimizationRun';
import { claimImmediateOptimizationRun } from '../../functions/src/optimizationTrigger';
import type { PushProvider } from '../../functions/src/pushProvider';
import { reoptimizeDelayedJourney } from '../../functions/src/routeModification';
import { createOsrmProvider, type RoutingProvider } from '../../functions/src/routing';
import { FAKE_OSRM_BASE_PATH, FAKE_OSRM_PORT, startFakeOsrm, type FakeOsrm } from '../fake-osrm';
import { startOptimizationService, type OptimizationService } from '../optimization-service';
import { admin, createClient, signUp, verifyEmail } from './support';

// Phase 8 acceptance ("the system can safely modify feasible trips when network conditions
// change"): the spec's own dynamic-insertion example (section 4) end to end, through the REAL Python
// optimization service (like phase6-acceptance.int.test.ts, for the same reason - this is the only
// automated check that modules 8.3/8.4/8.7's own calls into it, not just their TS orchestration,
// actually work). Individual modules' own edge cases (a driver/passenger detour limit, a protected
// constraint, an insertion candidate with no room) already have their own dedicated tests
// (planInsertion.int.test.ts, routeModification.int.test.ts, passengerConstraints.test.ts) - this
// file is only about the seam between modules across one real, continuous story: a fresh match (6.9),
// a second passenger inserted into it (8.3/8.4), a traffic delay detected (8.6) and safely re-ordered
// for (8.7), and a driver cancellation releasing someone back to the open pool (8.5) - each step
// notifying whoever it affects (8.9).

const NO_LIMITS = { globalSpacingMs: 0, perCallerPerMinute: 1_000 };

// Module 10.3 (trip matched push): this file is about the acceptance flow itself, not push delivery
// (which has its own tests) - a no-op stand-in is enough everywhere runBatchOptimization is called.
const noopPush: PushProvider = { sendPush: () => Promise.resolve({ status: 'sent' }) };

// Its own corner of the world (a longitude no other integration test file uses, not just another
// latitude sub-range - see routeModification.int.test.ts's own lesson on why that is the safer way to
// stay clear of other files' own leftover state in the shared emulator run), well south to north along
// one line: ORIGIN -> PICKUP_A -> PICKUP_B -> DROPOFF_B -> DROPOFF_A -> DESTINATION. A's own dropoff is
// its own distinct point, deliberately short of DESTINATION - buildJourneyStopMatrix (module 6.9 part
// 1) asks for a route between every ordered pair of stops, including DESTINATION_STOP and A's own
// dropoff stop; two different stop IDs at the exact same coordinates make that one pair a zero-distance
// route, which this fake OSRM (like a real one snapping both ends to the same road point) answers
// 'unavailable' for - so the two are kept apart by a small margin instead.
const ORIGIN = { latitude: 20, longitude: -150 };
const PICKUP_A = { latitude: 20.01, longitude: -150 };
const PICKUP_B = { latitude: 20.02, longitude: -150 };
const DROPOFF_B = { latitude: 20.04, longitude: -150 };
const DROPOFF_A = { latitude: 20.055, longitude: -150 };
const DESTINATION = { latitude: 20.06, longitude: -150 };

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
    plateNumber: `P8A-${Date.now() % 100000}`,
  });
  await setVehicleCapacity(client, 4);
  await admin().firestore.doc(`drivers/${uid}`).update({ verificationStatus: 'VERIFIED' });
  await admin().firestore.doc(`vehicles/${uid}`).update({ verificationStatus: 'VERIFIED' });
  await declareDestination(client, place(DESTINATION, 'Destination'));
  await setJourneyOrigin(client, ORIGIN);
  await setJourneySeats(client, 3);
  await setJourneyDetour(client, 15, 5);
  await setAvailability(client, 'ONLINE');
  const journeyId = (await admin().firestore.doc(`drivers/${uid}`).get()).get(
    'currentJourneyId',
  ) as string;
  return { client, uid, journeyId };
}

async function searchingPassenger(
  prefix: string,
  route: { origin: typeof ORIGIN; destination: typeof ORIGIN },
) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(
    client.functions,
    'completeRegistration',
  )({ role: 'PASSENGER', name: 'Test Passenger' });
  await verifyEmail(user, email);

  const tripId = await createTripRequest(client, {
    origin: place(route.origin, 'Pickup'),
    destination: place(route.destination, 'Destination'),
    departure: { kind: 'NOW' },
    arriveBy: null,
    preferences: BALANCED,
  });

  // Sole control of when the real optimization service is called - see phase6-acceptance's own note
  // on claiming the debounce window before module 8.1/8.2's own immediate trigger can.
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

async function notificationsFor(tripId: string) {
  return (
    await admin()
      .firestore.collection('notifications')
      .where('relatedEntity', '==', `tripRequests/${tripId}`)
      .get()
  ).docs.map((doc) => doc.data());
}

async function currentPlanId(journeyId: string): Promise<string> {
  const query = await admin()
    .firestore.collection('journeyPlans')
    .where('journeyId', '==', journeyId)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  const doc = query.docs[0];
  if (!doc) throw new Error('No plan found.');
  return doc.id;
}

describe('Phase 8 acceptance (functions + firestore emulators, the real optimization service)', () => {
  it('pools a second passenger into an already-matched journey, detects a delay, and safely re-orders the route - notifying everyone along the way', async () => {
    const driver = await onlineDriver('p8a-driver');

    // Module 6.9: a fresh match, journey AVAILABLE -> MATCHING.
    const a = await searchingPassenger('p8a-a', { origin: PICKUP_A, destination: DROPOFF_A });
    await runBatchOptimization({
      firestore: admin().firestore,
      provider,
      optimizationService: { baseUrl: optimizationService.baseUrl },
      limits: NO_LIMITS,
      push: noopPush,
    });
    const tripA = (await admin().firestore.doc(`tripRequests/${a.tripId}`).get()).data();
    expect(tripA?.status).toBe('PICKUP_ASSIGNED');
    expect(tripA?.matchedJourneyId).toBe(driver.journeyId);
    const planV1Id = await currentPlanId(driver.journeyId);

    // Modules 8.3/8.4: a second, still-SEARCHING passenger on the same corridor is inserted into
    // the now-MATCHING journey (phase 2 of runBatchOptimization, since phase 1 has no fresh
    // AVAILABLE journey left to match into).
    const b = await searchingPassenger('p8a-b', { origin: PICKUP_B, destination: DROPOFF_B });
    const outcome = await runBatchOptimization({
      firestore: admin().firestore,
      provider,
      optimizationService: { baseUrl: optimizationService.baseUrl },
      limits: NO_LIMITS,
      push: noopPush,
    });
    expect(outcome.insertedRequestCount).toBeGreaterThanOrEqual(1);

    const tripB = (await admin().firestore.doc(`tripRequests/${b.tripId}`).get()).data();
    expect(tripB?.status).toBe('PICKUP_ASSIGNED');
    expect(tripB?.matchedJourneyId).toBe(driver.journeyId);
    const planV2Id = await currentPlanId(driver.journeyId);
    expect(planV2Id).not.toBe(planV1Id);
    const planV2 = (await admin().firestore.doc(`journeyPlans/${planV2Id}`).get()).data();
    expect(planV2?.version).toBe(2);
    expect(planV2?.supersedes).toBe(planV1Id);
    expect(planV2?.requestIds).toEqual(expect.arrayContaining([a.tripId, b.tripId]));

    const journeyAfterInsertion = (
      await admin().firestore.doc(`driverJourneys/${driver.journeyId}`).get()
    ).data();
    expect(journeyAfterInsertion?.matchedTripRequestIds).toEqual(
      expect.arrayContaining([a.tripId, b.tripId]),
    );

    // Module 8.9: the new passenger and the existing one, each their own reason.
    expect(await notificationsFor(b.tripId)).toContainEqual(
      expect.objectContaining({ type: 'MATCHED_INTO_SHARED_RIDE' }),
    );
    expect(await notificationsFor(a.tripId)).toContainEqual(
      expect.objectContaining({ type: 'ROUTE_ADJUSTED_FOR_NEW_PASSENGER' }),
    );

    // Module 8.6: the driver falls behind their own plan's pace - backdate the current plan's own
    // createdAt (the same "move the last write back in time instead of waiting" trick
    // location.int.test.ts's own throttle tests use) so a real location update finds them hours
    // behind, whatever the real legs' own durations happen to be. Module 8.7's own lookup of "the
    // current plan" (routeModification.ts) is the same createdAt-ordered query currentPlanId above
    // uses, so planV1's own createdAt is backdated further still - staying the OLDER of the two -
    // rather than leaving it at its own real (recent) timestamp, which would otherwise outrank the
    // now-backdated planV2 and be picked up as "current" instead.
    await admin()
      .firestore.doc(`journeyPlans/${planV1Id}`)
      .update({ createdAt: new Date(Date.now() - 3 * 60 * 60_000) });
    await admin()
      .firestore.doc(`journeyPlans/${planV2Id}`)
      .update({ createdAt: new Date(Date.now() - 2 * 60 * 60_000) });
    expect(await updateDriverLocation(driver.client, { ...ORIGIN, accuracy: 5 })).toBe('updated');

    const journeyDelayed = (
      await admin().firestore.doc(`driverJourneys/${driver.journeyId}`).get()
    ).data();
    expect(journeyDelayed?.delay).toBeTruthy();
    expect(await notificationsFor(a.tripId)).toContainEqual(
      expect.objectContaining({ type: 'DRIVER_DELAYED' }),
    );
    expect(await notificationsFor(b.tripId)).toContainEqual(
      expect.objectContaining({ type: 'DRIVER_DELAYED' }),
    );

    // Module 8.7: re-ordered from the driver's current position, through the real service again.
    // Called directly (with NO_LIMITS), not via the real routeModificationOnDelay trigger (index.ts) -
    // that trigger DOES also fire on its own off the delay flag just set above, through the real,
    // unthrottled-by-this-test rate limits (module 4.3's own ROUTE_LIMITS.perCallerPerMinute, not
    // overridable from outside a direct call): a two-passenger buildJourneyStopMatrix needs 30 ordered
    // stop pairs, over that cap, so the trigger's own attempt harmlessly finds nothing usable and
    // no-ops - a real, pre-existing characteristic of buildJourneyStopMatrix's own O(n^2) call count
    // worth knowing about for a future journey carrying several passengers, not something to work
    // around here. NO_LIMITS lets this call's own 30 pairs succeed regardless of what the trigger's
    // own attempt already spent from the shared per-caller counter.
    const reoptOutcome = await reoptimizeDelayedJourney(
      {
        firestore: admin().firestore,
        provider,
        optimizationService: { baseUrl: optimizationService.baseUrl },
        limits: NO_LIMITS,
        push: noopPush,
      },
      driver.journeyId,
    );
    expect(reoptOutcome).toBe('reoptimized');

    const journeyReordered = (
      await admin().firestore.doc(`driverJourneys/${driver.journeyId}`).get()
    ).data();
    expect(journeyReordered?.delay).toBeNull();
    const planV3Id = await currentPlanId(driver.journeyId);
    expect(planV3Id).not.toBe(planV2Id);
    const planV3 = (await admin().firestore.doc(`journeyPlans/${planV3Id}`).get()).data();
    expect(planV3?.version).toBe(3);
    expect(planV3?.supersedes).toBe(planV2Id);

    // Module 8.9 again: both passengers were still waiting (neither had been picked up), so both
    // are kept and told their driver's route was updated - nobody was released this time.
    expect(await notificationsFor(a.tripId)).toContainEqual(
      expect.objectContaining({ type: 'ROUTE_UPDATED_AFTER_DELAY' }),
    );
    expect(await notificationsFor(b.tripId)).toContainEqual(
      expect.objectContaining({ type: 'ROUTE_UPDATED_AFTER_DELAY' }),
    );
  }, 120_000);

  it('releases a matched passenger back to SEARCHING, notifying them, when the driver cancels mid-match', async () => {
    const driver = await onlineDriver('p8a-cancel-driver');
    const a = await searchingPassenger('p8a-cancel-a', {
      origin: PICKUP_A,
      destination: DESTINATION,
    });
    await runBatchOptimization({
      firestore: admin().firestore,
      provider,
      optimizationService: { baseUrl: optimizationService.baseUrl },
      limits: NO_LIMITS,
      push: noopPush,
    });
    const tripBefore = (await admin().firestore.doc(`tripRequests/${a.tripId}`).get()).data();
    expect(tripBefore?.status).toBe('PICKUP_ASSIGNED');

    // Module 8.5: going offline mid-match releases the still-waiting passenger.
    expect(await setAvailability(driver.client, 'OFFLINE')).toBe('updated');

    const tripAfter = (await admin().firestore.doc(`tripRequests/${a.tripId}`).get()).data();
    expect(tripAfter?.status).toBe('SEARCHING');
    expect(tripAfter?.matchedJourneyId).toBeNull();

    // Module 8.9: the released passenger.
    expect(await notificationsFor(a.tripId)).toContainEqual(
      expect.objectContaining({ type: 'RELEASED_TO_SEARCHING' }),
    );
  }, 120_000);
});
