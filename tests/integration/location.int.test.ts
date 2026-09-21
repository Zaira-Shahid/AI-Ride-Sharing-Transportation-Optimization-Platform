import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  declareDestination,
  saveVehicle,
  setAvailability,
  setJourneyDetour,
  setJourneyOrigin,
  setJourneySeats,
  setVehicleCapacity,
  updateDriverLocation,
} from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

const OFFICE = {
  latitude: 51.5049,
  longitude: -0.0195,
  formattedAddress: '1 Canada Square, London E14 5AB, UK',
  placeId: 'place-office',
};
const START = { latitude: 51.4545, longitude: -2.5879 };
const MOVED = { latitude: 51.4601, longitude: -2.5802 };

let plateCounter = 0;
const uniquePlate = () => `LOC-${Date.now() % 100000}-${plateCounter++}`;

const call = (client: Client, name: string, data: unknown) =>
  httpsCallable(client.functions, name)(data);

async function person(role: 'DRIVER' | 'PASSENGER', prefix: string, verified = true) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
  if (verified) await verifyEmail(user, email);
  else await user.getIdToken(true);
  return { client, uid };
}

/** A verified driver with a vehicle and a destination: everything except the start and going online. */
async function driverWithDestination(prefix: string) {
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
  return driver;
}

/** A driver who is online, with a journey that has a start. */
async function onlineDriver(prefix: string) {
  const driver = await driverWithDestination(prefix);
  await setJourneyOrigin(driver.client, START);
  await setJourneySeats(driver.client, 3);
  await setJourneyDetour(driver.client, 10, 5);
  await setAvailability(driver.client, 'ONLINE');
  return driver;
}

const driverDoc = async (uid: string) =>
  (await admin().firestore.doc(`drivers/${uid}`).get()).data();
async function journeyOf(uid: string) {
  const id = (await driverDoc(uid))?.currentJourneyId as string;
  return { id, data: (await admin().firestore.doc(`driverJourneys/${id}`).get()).data() };
}
const auditFor = async (uid: string) =>
  (await admin().firestore.collection('auditLogs').where('actor', '==', uid).get()).docs.map(
    (entry) => entry.data(),
  );

// Plates are unique, so every test starts without vehicles.
beforeEach(async () => {
  const { firestore } = admin();
  await firestore.recursiveDelete(firestore.collection('vehicles'));
});

describe('setJourneyOrigin (functions + firestore emulators)', () => {
  it('saves the start as "Current location", with its coordinates and no place ID', async () => {
    const driver = await driverWithDestination('org-save');

    expect(await setJourneyOrigin(driver.client, START)).toBe('updated');

    expect((await journeyOf(driver.uid)).data).toMatchObject({
      origin: { ...START, formattedAddress: 'Current location', placeId: null },
      status: 'DRAFT',
    });
  });

  it('leaves the journey alone when the same start is saved again, and changes it for another', async () => {
    const driver = await driverWithDestination('org-repeat');
    await setJourneyOrigin(driver.client, START);

    expect(await setJourneyOrigin(driver.client, START)).toBe('unchanged');
    expect(await setJourneyOrigin(driver.client, MOVED)).toBe('updated');

    expect((await journeyOf(driver.uid)).data?.origin).toMatchObject(MOVED);
  });

  it('keeps the address the app found for the position, when there is one', async () => {
    const driver = await driverWithDestination('org-address');

    expect(await setJourneyOrigin(driver.client, START, '12 Test Street, Bristol, BS1 6QS')).toBe(
      'updated',
    );

    expect((await journeyOf(driver.uid)).data?.origin).toEqual({
      ...START,
      formattedAddress: '12 Test Street, Bristol, BS1 6QS',
      placeId: null,
    });
    // The same start with the same address changes nothing; a new address is a change.
    expect(await setJourneyOrigin(driver.client, START, '12 Test Street, Bristol, BS1 6QS')).toBe(
      'unchanged',
    );
    expect(await setJourneyOrigin(driver.client, START, '14 Test Street, Bristol')).toBe('updated');
    // Without an address it goes back to what it says when nothing better is known.
    expect(await setJourneyOrigin(driver.client, START)).toBe('updated');
    expect((await journeyOf(driver.uid)).data?.origin?.formattedAddress).toBe('Current location');
  });

  it.each([
    ['a blank address', '   '],
    ['an address over 300 characters', 'x'.repeat(301)],
    ['an address that is not text', 5],
  ])('refuses %s and stores nothing', async (_label, address) => {
    const driver = await driverWithDestination('org-badaddress');

    await expect(
      call(driver.client, 'setJourneyOrigin', { origin: START, address }),
    ).rejects.toMatchObject({ code: 'functions/invalid-argument' });

    expect((await journeyOf(driver.uid)).data?.origin).toBeNull();
  });

  it('needs a destination first', async () => {
    const driver = await person('DRIVER', 'org-nojourney');

    await expect(setJourneyOrigin(driver.client, START)).rejects.toMatchObject({
      kind: 'permission',
    });
    expect(await driverDoc(driver.uid)).toMatchObject({ currentJourneyId: null });
  });

  it.each([
    ['0, 0', { latitude: 0, longitude: 0 }],
    ['a latitude out of range', { latitude: 91, longitude: 0 }],
    ['a longitude out of range', { latitude: 0, longitude: 181 }],
    ['text for a number', { latitude: '51', longitude: 0 }],
    ['a missing longitude', { latitude: 51 }],
    ['nothing', null],
  ])('refuses %s and stores nothing', async (_label, origin) => {
    const driver = await driverWithDestination('org-bad');

    await expect(call(driver.client, 'setJourneyOrigin', { origin })).rejects.toMatchObject({
      code: 'functions/invalid-argument',
    });

    expect((await journeyOf(driver.uid)).data?.origin).toBeNull();
  });

  it('is for verified drivers only, and only while the journey is a draft', async () => {
    const passenger = await person('PASSENGER', 'org-passenger');
    const unverified = await person('DRIVER', 'org-unverified', false);
    for (const client of [passenger.client, unverified.client]) {
      await expect(call(client, 'setJourneyOrigin', { origin: START })).rejects.toMatchObject({
        code: 'functions/permission-denied',
      });
    }

    const driver = await driverWithDestination('org-active');
    const { id } = await journeyOf(driver.uid);
    await admin().firestore.doc(`driverJourneys/${id}`).update({ status: 'ACTIVE' });
    await expect(call(driver.client, 'setJourneyOrigin', { origin: START })).rejects.toMatchObject({
      code: 'functions/failed-precondition',
    });
  });

  it('is a requirement for going online', async () => {
    const driver = await driverWithDestination('org-required');
    await setJourneySeats(driver.client, 3);
    await setJourneyDetour(driver.client, 10, 5);

    await expect(
      call(driver.client, 'setAvailability', { status: 'ONLINE' }),
    ).rejects.toMatchObject({
      code: 'functions/failed-precondition',
      details: { unmet: ['originSet'] },
    });

    await setJourneyOrigin(driver.client, START);
    expect(await setAvailability(driver.client, 'ONLINE')).toBe('updated');
  });

  it('does not write the position to the audit log', async () => {
    const driver = await driverWithDestination('org-audit');
    await setJourneyOrigin(driver.client, START);

    const text = JSON.stringify(await auditFor(driver.uid));
    expect(text).not.toContain('51.4545');
    expect(text).not.toContain('2.5879');
  });
});

describe('updateDriverLocation (functions + firestore emulators)', () => {
  it('stores the position, its accuracy and the server time on the journey of an online driver', async () => {
    const driver = await onlineDriver('loc-store');
    expect((await journeyOf(driver.uid)).data?.currentLocation).toBeNull();

    expect(await updateDriverLocation(driver.client, { ...MOVED, accuracy: 12 })).toBe('updated');

    const location = (await journeyOf(driver.uid)).data?.currentLocation;
    expect(location).toMatchObject({ ...MOVED, accuracy: 12 });
    expect(location.updatedAt.toMillis()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('stores an unknown accuracy as null', async () => {
    const driver = await onlineDriver('loc-noaccuracy');

    await updateDriverLocation(driver.client, MOVED);

    expect((await journeyOf(driver.uid)).data?.currentLocation).toMatchObject({ accuracy: null });
  });

  it('refuses a driver who is offline, and stores nothing', async () => {
    const driver = await driverWithDestination('loc-offline');
    await setJourneyOrigin(driver.client, START);

    await expect(
      call(driver.client, 'updateDriverLocation', { ...MOVED, accuracy: 5 }),
    ).rejects.toMatchObject({ code: 'functions/failed-precondition' });

    expect((await journeyOf(driver.uid)).data?.currentLocation).toBeNull();
  });

  it('throttles a second reading straight after the first, whatever the app does', async () => {
    const driver = await onlineDriver('loc-throttle');
    await updateDriverLocation(driver.client, START);

    expect(await updateDriverLocation(driver.client, MOVED)).toBe('throttled');

    expect((await journeyOf(driver.uid)).data?.currentLocation).toMatchObject(START);
  });

  it('accepts the next reading once 15 seconds have passed', async () => {
    const driver = await onlineDriver('loc-after');
    await updateDriverLocation(driver.client, START);
    const { id } = await journeyOf(driver.uid);
    // Move the last write back in time instead of waiting.
    await admin()
      .firestore.doc(`driverJourneys/${id}`)
      .update({ 'currentLocation.updatedAt': new Date(Date.now() - 20_000) });

    expect(await updateDriverLocation(driver.client, MOVED)).toBe('updated');

    expect((await journeyOf(driver.uid)).data?.currentLocation).toMatchObject(MOVED);
  });

  it('still throttles at 14 seconds', async () => {
    const driver = await onlineDriver('loc-14');
    await updateDriverLocation(driver.client, START);
    const { id } = await journeyOf(driver.uid);
    await admin()
      .firestore.doc(`driverJourneys/${id}`)
      .update({ 'currentLocation.updatedAt': new Date(Date.now() - 14_000) });

    expect(await updateDriverLocation(driver.client, MOVED)).toBe('throttled');
  });

  it('ignores a reading less accurate than 100 metres, and stores nothing', async () => {
    const driver = await onlineDriver('loc-inaccurate');

    expect(await updateDriverLocation(driver.client, { ...MOVED, accuracy: 100.5 })).toBe(
      'ignored',
    );
    expect((await journeyOf(driver.uid)).data?.currentLocation).toBeNull();

    // An ignored reading does not start the throttle: a good one right after is stored.
    expect(await updateDriverLocation(driver.client, { ...MOVED, accuracy: 100 })).toBe('updated');
  });

  it.each([
    ['0, 0', { latitude: 0, longitude: 0, accuracy: 5 }],
    ['a latitude out of range', { latitude: 95, longitude: 0, accuracy: 5 }],
    ['a negative accuracy', { latitude: 51, longitude: 0, accuracy: -1 }],
    ['text for a number', { latitude: '51', longitude: 0 }],
    ['a missing longitude', { latitude: 51 }],
  ])('refuses %s', async (_label, reading) => {
    const driver = await onlineDriver('loc-invalid');

    await expect(call(driver.client, 'updateDriverLocation', reading)).rejects.toMatchObject({
      code: 'functions/invalid-argument',
    });

    expect((await journeyOf(driver.uid)).data?.currentLocation).toBeNull();
  });

  it('is for verified drivers only', async () => {
    const passenger = await person('PASSENGER', 'loc-passenger');
    const unverified = await person('DRIVER', 'loc-unverified', false);
    for (const client of [passenger.client, unverified.client]) {
      await expect(call(client, 'updateDriverLocation', MOVED)).rejects.toMatchObject({
        code: 'functions/permission-denied',
      });
    }
    await expect(call(createClient(), 'updateDriverLocation', MOVED)).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });
  });

  it('refuses a suspended account', async () => {
    const driver = await onlineDriver('loc-suspended');
    await admin().firestore.doc(`users/${driver.uid}`).update({ status: 'SUSPENDED' });

    await expect(call(driver.client, 'updateDriverLocation', MOVED)).rejects.toMatchObject({
      code: 'functions/failed-precondition',
    });
  });

  it("writes only to the caller's own journey", async () => {
    const first = await onlineDriver('loc-own-1');
    const second = await onlineDriver('loc-own-2');

    await updateDriverLocation(first.client, START);

    expect((await journeyOf(first.uid)).data?.currentLocation).toMatchObject(START);
    expect((await journeyOf(second.uid)).data?.currentLocation).toBeNull();
  });

  it('is removed when the driver goes offline, and starts fresh when they go online again', async () => {
    const driver = await onlineDriver('loc-clear');
    await updateDriverLocation(driver.client, START);
    expect((await journeyOf(driver.uid)).data?.currentLocation).not.toBeNull();

    await setAvailability(driver.client, 'OFFLINE');
    expect((await journeyOf(driver.uid)).data?.currentLocation).toBeNull();

    await setAvailability(driver.client, 'ONLINE');
    expect(await updateDriverLocation(driver.client, MOVED)).toBe('updated');
  });

  it('does not write the position to the audit log', async () => {
    const driver = await onlineDriver('loc-audit');
    await updateDriverLocation(driver.client, MOVED);

    const text = JSON.stringify(await auditFor(driver.uid));
    expect(text).not.toContain('51.4601');
    expect(text).not.toContain('2.5802');
  });
});
