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
import { checkCandidateRoute, findCandidateJourneysNow } from '../../functions/src/matching';
import type { Route, RoutePoint, RoutingProvider } from '../../functions/src/routing';
import { startFakeOsrm, type FakeOsrm } from '../fake-osrm';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

// Candidate discovery (Module 5.2): the first describe block calls findCandidateJourneysNow
// directly. Starting the search (Module 5.3, the trigger that runs it automatically and moves a
// trip request on to SEARCHING) is the second describe block, end to end. Route compatibility
// (Module 5.4, checkCandidateRoute) is the third, with a stand-in routing provider - the same way
// routing.int.test.ts tests calculateRoute's own logic. Assignment (Module 5.5) is the fourth, end
// to end against a real fake OSRM (as estimate.int.test.ts does for the estimate trigger), since the
// trigger it is wired into (matchTripRequestOnCreate) asks for real routes through it.

let fake: FakeOsrm;
beforeAll(async () => {
  fake = await startFakeOsrm();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  const { firestore } = admin();
  for (const name of ['routeCache', 'routeLimits', 'routeGlobal']) {
    await firestore.recursiveDelete(firestore.collection(name));
  }
  fake.requests.length = 0;
  fake.reply(null);
});

const ORIGIN = { latitude: 51.4545, longitude: -2.5879 };
const OFFICE = {
  latitude: 51.5049,
  longitude: -0.0195,
  formattedAddress: '1 Canada Square, London E14 5AB, UK',
  placeId: 'place-office',
};
// A pickup a few hundred metres from ORIGIN, heading the same way as ORIGIN -> OFFICE.
const NEARBY_PICKUP = { latitude: 51.456, longitude: -2.585 };
// Far enough from every driver in these tests that it can never be a candidate.
const FAR_PICKUP = { latitude: 52.5, longitude: -1.9 };

let plateCounter = 0;
const uniquePlate = () => `MAT-${Date.now() % 100000}-${plateCounter++}`;

async function person(role: 'DRIVER' | 'PASSENGER', prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
  await verifyEmail(user, email);
  return { client, uid, email };
}

const driverRef = (uid: string) => admin().firestore.doc(`drivers/${uid}`);
const vehicleRef = (uid: string) => admin().firestore.doc(`vehicles/${uid}`);

/** A driver online with a journey ORIGIN -> OFFICE and `seats` available. */
async function onlineDriver(prefix: string, seats = 3): Promise<Client> {
  const driver = await person('DRIVER', prefix);
  await saveVehicle(driver.client, {
    type: 'CAR',
    make: 'Toyota',
    model: 'Corolla',
    plateNumber: uniquePlate(),
  });
  await setVehicleCapacity(driver.client, 4);
  await driverRef(driver.uid).update({ verificationStatus: 'VERIFIED' });
  await vehicleRef(driver.uid).update({ verificationStatus: 'VERIFIED' });
  await declareDestination(driver.client, OFFICE);
  await setJourneyOrigin(driver.client, ORIGIN);
  await setJourneySeats(driver.client, seats);
  await setJourneyDetour(driver.client, 10, 5);
  await setAvailability(driver.client, 'ONLINE');
  return driver.client;
}

describe('findCandidateJourneysNow (functions + firestore emulators)', () => {
  it('finds a nearby online driver heading the same way', async () => {
    await onlineDriver('match-found');

    const candidates = await findCandidateJourneysNow(
      { firestore: admin().firestore },
      { origin: NEARBY_PICKUP, destination: OFFICE },
    );

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.distanceMeters).toBeGreaterThan(0);
  });

  it('ignores a driver who is offline (DRAFT, not AVAILABLE)', async () => {
    const driver = await person('DRIVER', 'match-offline');
    await saveVehicle(driver.client, {
      type: 'CAR',
      make: 'Toyota',
      model: 'Corolla',
      plateNumber: uniquePlate(),
    });
    await setVehicleCapacity(driver.client, 4);
    await declareDestination(driver.client, OFFICE);
    await setJourneyOrigin(driver.client, ORIGIN);
    await setJourneySeats(driver.client, 3);
    // Never verified, never goes online: the journey stays DRAFT.

    const candidates = await findCandidateJourneysNow(
      { firestore: admin().firestore },
      { origin: NEARBY_PICKUP, destination: OFFICE },
    );

    // Other tests in this file leave their own drivers ONLINE (Module 5.1 has no going-offline-at-
    // the-end-of-the-test step), so the pool is not necessarily empty - only this driver is checked.
    expect(candidates.some((c) => c.driverId === driver.uid)).toBe(false);
  });

  it('ignores a driver too far from the pickup', async () => {
    await onlineDriver('match-far');

    const candidates = await findCandidateJourneysNow(
      { firestore: admin().firestore },
      { origin: FAR_PICKUP, destination: OFFICE },
    );

    expect(candidates).toEqual([]);
  });

  it('finds several nearby drivers, nearest first', async () => {
    await onlineDriver('match-multi-a');
    await onlineDriver('match-multi-b');

    const candidates = await findCandidateJourneysNow(
      { firestore: admin().firestore },
      { origin: NEARBY_PICKUP, destination: OFFICE },
    );

    expect(candidates.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < candidates.length; i += 1) {
      expect(candidates[i]!.distanceMeters).toBeGreaterThanOrEqual(
        candidates[i - 1]!.distanceMeters,
      );
    }
  });
});

describe('matchTripRequestOnCreate (the trigger, functions + firestore emulators)', () => {
  const BALANCED = {
    flexibilityLevel: 'BALANCED' as const,
    maxWalkingDistance: 500,
    maxExtraTime: 10,
    maxDetourDistance: 3,
    allowSharedRide: true,
    allowRouteChange: true,
  };
  const place = (point: { latitude: number; longitude: number }, address: string) => ({
    ...point,
    formattedAddress: address,
    placeId: null,
  });

  async function passenger(prefix: string) {
    const client = createClient();
    const { user, uid, email } = await signUp(client, prefix);
    await httpsCallable(
      client.functions,
      'completeRegistration',
    )({
      role: 'PASSENGER',
      name: 'Test Passenger',
    });
    await verifyEmail(user, email);
    return { client, uid };
  }

  async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
    const stop = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() > stop) throw new Error('Timed out waiting.');
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  const searchingTrip = (tripId: string) => async () => {
    const data = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    return data?.status === 'SEARCHING' ? data : undefined;
  };

  it('starts SEARCHING with a candidate count, for a leave-now request near an online driver', async () => {
    await onlineDriver('match-trigger-found');
    const { client } = await passenger('match-trigger-p1');

    const tripId = await createTripRequest(client, {
      origin: place(NEARBY_PICKUP, 'Pickup'),
      destination: place(OFFICE, OFFICE.formattedAddress),
      departure: { kind: 'NOW' },
      arriveBy: null,
      preferences: BALANCED,
    });

    const trip = await waitFor(searchingTrip(tripId));
    expect(trip.candidateCount).toBeGreaterThan(0);
  });

  it('starts SEARCHING with a candidate count of 0 for a leave-now request with no driver nearby', async () => {
    const { client } = await passenger('match-trigger-p2');

    const tripId = await createTripRequest(client, {
      origin: place(FAR_PICKUP, 'Pickup'),
      destination: place(OFFICE, OFFICE.formattedAddress),
      departure: { kind: 'NOW' },
      arriveBy: null,
      preferences: BALANCED,
    });

    const trip = await waitFor(searchingTrip(tripId));
    expect(trip.candidateCount).toBe(0);
  });

  it('starts SEARCHING with no candidate count for a future-dated request', async () => {
    const { client } = await passenger('match-trigger-future');
    const leaveAt = Math.ceil((Date.now() + 30 * 60_000) / 60_000) * 60_000;

    const tripId = await createTripRequest(client, {
      origin: place(NEARBY_PICKUP, 'Pickup'),
      destination: place(OFFICE, OFFICE.formattedAddress),
      departure: { kind: 'AT', at: leaveAt },
      arriveBy: null,
      preferences: BALANCED,
    });

    const trip = await waitFor(searchingTrip(tripId));
    expect(trip.candidateCount).toBeNull();
  });
});

describe('checkCandidateRoute (functions + firestore emulators, a stand-in provider)', () => {
  const NO_LIMITS = { globalSpacingMs: 0, perCallerPerMinute: 1_000 };

  /** Answers by how many stops were asked for: 2 is the driver's own route, 4 is with the passenger. */
  function stubProvider(byStopCount: Partial<Record<number, Route | null>>): RoutingProvider {
    return {
      route: (stops: RoutePoint[]) => Promise.resolve(byStopCount[stops.length] ?? null),
    };
  }

  const route = (distanceMeters: number, durationSeconds: number): Route => ({
    distanceMeters,
    durationSeconds,
    geometry: '_p~iF~ps|U',
    legs: [{ distanceMeters, durationSeconds }],
  });

  let counter = 0;
  /** A different, distant set of points for every test, so no test's routes share a cache entry. */
  function points(): {
    driverOrigin: RoutePoint;
    driverDestination: RoutePoint;
    passengerPickup: RoutePoint;
    passengerDestination: RoutePoint;
  } {
    counter += 1;
    const base = 10 + counter * 2;
    return {
      driverOrigin: { latitude: base, longitude: base },
      driverDestination: { latitude: base + 1, longitude: base + 1 },
      passengerPickup: { latitude: base + 0.2, longitude: base + 0.2 },
      passengerDestination: { latitude: base + 0.5, longitude: base + 0.5 },
    };
  }

  const LIMITS = {
    driverMaxDetourMinutes: 10,
    driverMaxDetourDistanceKm: 3,
    passengerMaxExtraMinutes: 10,
    passengerMaxDetourDistanceKm: 3,
  };

  it('is checked and compatible when both routes are found and the detour is small', async () => {
    const provider = stubProvider({ 2: route(10_000, 900), 4: route(11_000, 1_050) });

    const result = await checkCandidateRoute(
      { firestore: admin().firestore, provider, limits: NO_LIMITS },
      { driverId: 'driver-rc-1', passengerId: 'passenger-rc-1', ...points(), ...LIMITS },
    );

    expect(result).toEqual({
      status: 'checked',
      compatible: true,
      additionalDistanceMeters: 1_000,
      additionalDurationSeconds: 150,
    });
  });

  it('is checked but not compatible when the detour is too big', async () => {
    const provider = stubProvider({ 2: route(10_000, 900), 4: route(20_000, 900) });

    const result = await checkCandidateRoute(
      { firestore: admin().firestore, provider, limits: NO_LIMITS },
      { driverId: 'driver-rc-2', passengerId: 'passenger-rc-2', ...points(), ...LIMITS },
    );

    expect(result).toEqual({
      status: 'checked',
      compatible: false,
      additionalDistanceMeters: 10_000,
      additionalDurationSeconds: 0,
    });
  });

  it('is unavailable when the route with the passenger cannot be found', async () => {
    const provider = stubProvider({ 2: route(10_000, 900), 4: null });

    const result = await checkCandidateRoute(
      { firestore: admin().firestore, provider, limits: NO_LIMITS },
      { driverId: 'driver-rc-3', passengerId: 'passenger-rc-3', ...points(), ...LIMITS },
    );

    expect(result).toEqual({ status: 'unavailable' });
  });

  it('is unavailable when the driver own route cannot be found', async () => {
    const provider = stubProvider({ 2: null, 4: route(11_000, 1_000) });

    const result = await checkCandidateRoute(
      { firestore: admin().firestore, provider, limits: NO_LIMITS },
      { driverId: 'driver-rc-4', passengerId: 'passenger-rc-4', ...points(), ...LIMITS },
    );

    expect(result).toEqual({ status: 'unavailable' });
  });
});

describe('assignment end to end (Module 5.5, functions + firestore emulators, a real fake OSRM)', () => {
  // Its own corner of the world, well away from every other describe block's coordinates in this
  // file, so no leftover driver from another test is ever a candidate here.
  const A_ORIGIN = { latitude: 58, longitude: -1 };
  const A_DESTINATION = { latitude: 58.05, longitude: -0.95 };
  const A_PICKUP = { latitude: 58.005, longitude: -0.995 };

  const place = (point: RoutePoint, address: string) => ({
    ...point,
    formattedAddress: address,
    placeId: null,
  });
  const BALANCED = {
    flexibilityLevel: 'BALANCED' as const,
    maxWalkingDistance: 500,
    maxExtraTime: 10,
    maxDetourDistance: 3,
    allowSharedRide: true,
    allowRouteChange: true,
  };

  async function onlineDriverAt(prefix: string, origin: RoutePoint, destination: RoutePoint) {
    const client = createClient();
    const { user, uid, email } = await signUp(client, prefix);
    await httpsCallable(
      client.functions,
      'completeRegistration',
    )({
      role: 'DRIVER',
      name: 'Test Driver',
    });
    await verifyEmail(user, email);
    await saveVehicle(client, {
      type: 'CAR',
      make: 'Toyota',
      model: 'Corolla',
      plateNumber: `ASN-${Date.now() % 100000}-${uid.slice(0, 4)}`,
    });
    await setVehicleCapacity(client, 4);
    await admin().firestore.doc(`drivers/${uid}`).update({ verificationStatus: 'VERIFIED' });
    await admin().firestore.doc(`vehicles/${uid}`).update({ verificationStatus: 'VERIFIED' });
    await declareDestination(client, place(destination, 'Destination'));
    await setJourneyOrigin(client, origin);
    await setJourneySeats(client, 3);
    await setJourneyDetour(client, 10, 5);
    await setAvailability(client, 'ONLINE');
    return { client, uid };
  }

  async function passenger(prefix: string) {
    const client = createClient();
    const { user, uid, email } = await signUp(client, prefix);
    await httpsCallable(
      client.functions,
      'completeRegistration',
    )({
      role: 'PASSENGER',
      name: 'Test Passenger',
    });
    await verifyEmail(user, email);
    return { client, uid };
  }

  async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
    const stop = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() > stop) throw new Error('Timed out waiting.');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const matchedTrip = (tripId: string) => async () => {
    const data = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    // Only MATCHED settles this: SEARCHING is also what a leave-now request looks like the moment
    // discovery (Stage 1) finishes and before assignment (Stage 2 onwards), which runs a little
    // longer, in the same trigger invocation - waiting on it too would return before assignment had
    // its chance to run.
    return data?.status === 'MATCHED' ? data : undefined;
  };
  const searchingTrip = (tripId: string) => async () => {
    const data = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    return data?.status === 'SEARCHING' ? data : undefined;
  };

  it('matches a leave-now request to a nearby, compatible driver', async () => {
    const driver = await onlineDriverAt('assign-driver', A_ORIGIN, A_DESTINATION);
    const { client } = await passenger('assign-passenger');

    // The passenger goes to exactly where the driver is already headed, from right beside the
    // driver's own start: the smallest possible detour.
    const tripId = await createTripRequest(client, {
      origin: place(A_PICKUP, 'Pickup'),
      destination: place(A_DESTINATION, 'Destination'),
      departure: { kind: 'NOW' },
      arriveBy: null,
      preferences: BALANCED,
    });

    const trip = await waitFor(matchedTrip(tripId), 30_000);
    expect(trip.status).toBe('MATCHED');
    expect(trip.matchedDriverId).toBe(driver.uid);
    expect(trip.matchedJourneyId).toEqual(expect.any(String));

    const journey = (
      await admin().firestore.doc(`driverJourneys/${trip.matchedJourneyId}`).get()
    ).data();
    expect(journey?.status).toBe('MATCHING');
    expect(journey?.matchedTripRequestId).toBe(tripId);
  });

  it('stays SEARCHING, unmatched, when there is no driver nearby', async () => {
    const { client } = await passenger('assign-nobody');

    const tripId = await createTripRequest(client, {
      origin: place({ latitude: 59, longitude: -5 }, 'Pickup'),
      destination: place({ latitude: 59.05, longitude: -4.95 }, 'Destination'),
      departure: { kind: 'NOW' },
      arriveBy: null,
      preferences: BALANCED,
    });

    const trip = await waitFor(searchingTrip(tripId), 30_000);
    expect(trip.status).toBe('SEARCHING');
    expect(trip.candidateCount).toBe(0);
    expect(trip.matchedJourneyId).toBeNull();
  });
});
