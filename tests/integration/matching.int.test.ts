import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
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
import { findCandidateJourneysNow } from '../../functions/src/matching';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

// Candidate discovery (Module 5.2): the first describe block calls findCandidateJourneysNow
// directly. Starting the search (Module 5.3, the trigger that runs it automatically and moves a
// trip request on to SEARCHING) is the second describe block, end to end.

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
