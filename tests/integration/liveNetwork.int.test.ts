import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import {
  declareDestination,
  saveVehicle,
  setAvailability,
  setJourneyDetour,
  setJourneyOrigin,
  setJourneySeats,
  setVehicleCapacity,
  subscribeToActiveVehicles,
  updateDriverLocation,
  type ActiveVehicle,
} from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

// Module 11.5 (admin dashboard: live map, first pass - vehicles only). Unlike tripRequests
// (module 11.4), driverJourneys already has a direct staff read rule (docs/security.md), so
// subscribeToActiveVehicles is a real Firestore subscription - this file covers that it reflects a
// real online driver's position, excludes an offline one, and that a non-staff caller is refused by
// the rule itself (not by this function - it has no auth logic of its own).

const OFFICE = {
  latitude: 51.5049,
  longitude: -0.0195,
  formattedAddress: '1 Canada Square, London E14 5AB, UK',
  placeId: 'place-office',
};
const ORIGIN = { latitude: 51.4545, longitude: -2.5879 };
let plateCounter = 0;
const uniquePlate = () => `LNW-${Date.now() % 100000}-${plateCounter++}`;

async function person(role: 'DRIVER' | 'PASSENGER', prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
  await verifyEmail(user, email);
  return { client, uid, email };
}

async function staff(prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await admin().auth.setCustomUserClaims(uid, { role: 'ADMIN' });
  await verifyEmail(user, email);
  return { client, uid };
}

/** A driver who meets every requirement to go online. */
async function eligibleDriver(prefix: string) {
  const driver = await person('DRIVER', prefix);
  await saveVehicle(driver.client, {
    type: 'CAR',
    make: 'Toyota',
    model: 'Corolla',
    plateNumber: uniquePlate(),
  });
  await setVehicleCapacity(driver.client, 4);
  await admin().firestore.doc(`drivers/${driver.uid}`).update({ verificationStatus: 'VERIFIED' });
  await admin().firestore.doc(`vehicles/${driver.uid}`).update({ verificationStatus: 'VERIFIED' });
  await declareDestination(driver.client, OFFICE);
  await setJourneyOrigin(driver.client, ORIGIN);
  await setJourneySeats(driver.client, 3);
  await setJourneyDetour(driver.client, 10, 5);
  return driver;
}

async function journeyIdOf(uid: string) {
  return (await admin().firestore.doc(`drivers/${uid}`).get()).get('currentJourneyId') as string;
}

async function subscribeOnce(client: Client) {
  const readings: ActiveVehicle[][] = [];
  const errors: unknown[] = [];
  const unsubscribe = subscribeToActiveVehicles(
    client,
    (vehicles) => readings.push(vehicles),
    (error) => errors.push(error),
  );
  return { readings, errors, unsubscribe };
}

describe('subscribeToActiveVehicles (functions + firestore + auth emulators)', () => {
  it('shows an online driver with a shared position, live', async () => {
    const reviewer = await staff('lnw-reviewer');
    const driver = await eligibleDriver('lnw-online');
    const journeyId = await journeyIdOf(driver.uid);
    await setAvailability(driver.client, 'ONLINE');
    await updateDriverLocation(driver.client, { latitude: 51.5, longitude: -0.02 });

    const { readings, unsubscribe } = await subscribeOnce(reviewer.client);
    try {
      // Matched by this test's own journeyId, never by position/status alone - the whole test suite
      // shares one long-lived Firestore, so other files' own leftover online drivers are always in
      // the same subscription's results too.
      await expect
        .poll(() => readings.at(-1)?.find((v) => v.journeyId === journeyId))
        .toMatchObject({
          status: 'AVAILABLE',
          currentPosition: { latitude: 51.5, longitude: -0.02 },
          origin: ORIGIN,
          destination: { latitude: OFFICE.latitude, longitude: OFFICE.longitude },
        });
    } finally {
      unsubscribe();
    }
  });

  it('does not show a driver who never went online', async () => {
    const reviewer = await staff('lnw-offline-reviewer');
    const driver = await eligibleDriver('lnw-offline');
    const journeyId = (await admin().firestore.doc(`drivers/${driver.uid}`).get()).get(
      'currentJourneyId',
    ) as string;

    const { readings, unsubscribe } = await subscribeOnce(reviewer.client);
    try {
      // No positive event to poll for (this driver's journey should never appear at all), so a fixed
      // wait is used instead - the same as any other "confirm something never happens" assertion.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(readings.at(-1)?.some((v) => v.journeyId === journeyId)).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('stops showing a driver once they go offline', async () => {
    const reviewer = await staff('lnw-toggled-reviewer');
    const driver = await eligibleDriver('lnw-toggled');
    const journeyId = await journeyIdOf(driver.uid);
    await setAvailability(driver.client, 'ONLINE');
    await updateDriverLocation(driver.client, { latitude: 51.5, longitude: -0.02 });

    const { readings, unsubscribe } = await subscribeOnce(reviewer.client);
    try {
      await expect.poll(() => readings.at(-1)?.some((v) => v.journeyId === journeyId)).toBe(true);

      await setAvailability(driver.client, 'OFFLINE');
      await expect.poll(() => readings.at(-1)?.some((v) => v.journeyId === journeyId)).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('refuses a non-staff caller, via the rule itself', async () => {
    const passenger = await person('PASSENGER', 'lnw-refuse-passenger');
    const { errors, unsubscribe } = await subscribeOnce(passenger.client);
    try {
      await expect.poll(() => errors.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });
});
