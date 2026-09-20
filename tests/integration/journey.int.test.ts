import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  declareDestination,
  describeAuthError,
  saveVehicle,
  setAvailability,
  setVehicleCapacity,
  subscribeToJourney,
  type JourneySnapshot,
} from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

const OFFICE = {
  latitude: 51.5049,
  longitude: -0.0195,
  formattedAddress: '1 Canada Square, London E14 5AB, UK',
  placeId: 'place-office',
};
const HOME = {
  latitude: 51.4545,
  longitude: -2.5879,
  formattedAddress: 'Temple Meads, Bristol BS1 6QS, UK',
  placeId: 'place-home',
};

let plateCounter = 0;
const uniquePlate = () => `JNY-${Date.now() % 100000}-${plateCounter++}`;

const call = (client: Client, name: string, data: unknown) =>
  httpsCallable(client.functions, name)(data);

async function person(role: 'DRIVER' | 'PASSENGER', prefix: string, verified = true) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
  if (verified) await verifyEmail(user, email);
  else await user.getIdToken(true);
  return { client, uid, email };
}

/** A verified driver who has added a vehicle, so they can declare a destination. */
async function driver(prefix: string) {
  const person_ = await person('DRIVER', prefix);
  await saveVehicle(person_.client, {
    type: 'CAR',
    make: 'Toyota',
    model: 'Corolla',
    plateNumber: uniquePlate(),
  });
  return person_;
}

const driverDoc = async (uid: string) =>
  (await admin().firestore.doc(`drivers/${uid}`).get()).data();
const journeyDoc = async (id: string) =>
  (await admin().firestore.doc(`driverJourneys/${id}`).get()).data();
const journeysOf = async (uid: string) =>
  (await admin().firestore.collection('driverJourneys').where('driverId', '==', uid).get()).docs;
const createdAudit = async (id: string) =>
  (
    await admin()
      .firestore.collection('auditLogs')
      .where('entity', '==', `driverJourneys/${id}`)
      .get()
  ).docs;

async function currentJourneyId(uid: string) {
  const id = (await driverDoc(uid))?.currentJourneyId;
  if (typeof id !== 'string') throw new Error('The driver has no journey.');
  return id;
}

// Plates are unique, so every test starts without vehicles.
beforeEach(async () => {
  const { firestore } = admin();
  await firestore.recursiveDelete(firestore.collection('vehicles'));
});

describe('declareDestination (functions + firestore emulators)', () => {
  it('starts a draft journey with the destination, and points the driver at it', async () => {
    const { client, uid } = await driver('jny-new');
    expect((await driverDoc(uid))?.currentJourneyId).toBeNull();

    expect(await declareDestination(client, OFFICE)).toBe('created');

    const id = await currentJourneyId(uid);
    expect(await journeyDoc(id)).toMatchObject({
      driverId: uid,
      vehicleId: uid,
      destination: OFFICE,
      origin: null,
      departureTime: null,
      availableSeats: null,
      maxDetourMinutes: null,
      maxDetourDistance: null,
      status: 'DRAFT',
      currentLocation: null,
      currentRoute: null,
    });
    expect((await journeyDoc(id))?.createdAt).toBeDefined();
  });

  it('audits the start of the journey without writing the address', async () => {
    const { client, uid } = await driver('jny-audit');
    await declareDestination(client, OFFICE);
    const id = await currentJourneyId(uid);

    const entries = await createdAudit(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data()).toMatchObject({
      actor: uid,
      action: 'JOURNEY_CREATED',
      previousState: null,
      newState: { status: 'DRAFT' },
    });
    expect(JSON.stringify(entries[0]?.data())).not.toContain('Canada Square');
    expect(JSON.stringify(entries[0]?.data())).not.toContain('51.5049');
  });

  it('replaces the destination of the same journey, and does nothing when it is unchanged', async () => {
    const { client, uid } = await driver('jny-change');
    await declareDestination(client, OFFICE);
    const id = await currentJourneyId(uid);

    expect(await declareDestination(client, OFFICE)).toBe('unchanged');
    expect(await declareDestination(client, HOME)).toBe('updated');

    expect(await currentJourneyId(uid)).toBe(id);
    expect((await journeyDoc(id))?.destination).toEqual(HOME);
    expect(await journeysOf(uid)).toHaveLength(1);
    expect(await createdAudit(id)).toHaveLength(1);
  });

  it('keeps the rest of the journey when the destination changes', async () => {
    const { client, uid } = await driver('jny-keep');
    await declareDestination(client, OFFICE);
    const id = await currentJourneyId(uid);
    await admin().firestore.doc(`driverJourneys/${id}`).update({ availableSeats: 2 });

    await declareDestination(client, HOME);
    expect(await journeyDoc(id)).toMatchObject({ availableSeats: 2, status: 'DRAFT' });
  });

  it('stores a missing place ID as null', async () => {
    const { client, uid } = await driver('jny-noplace');
    const withoutPlace = {
      latitude: OFFICE.latitude,
      longitude: OFFICE.longitude,
      formattedAddress: OFFICE.formattedAddress,
    };
    await call(client, 'declareDestination', { destination: withoutPlace });
    const id = await currentJourneyId(uid);
    expect((await journeyDoc(id))?.destination).toMatchObject({ placeId: null });

    // Null and absent are the same place, so nothing changes; a place ID makes it a new one.
    expect(await declareDestination(client, { ...OFFICE, placeId: null })).toBe('unchanged');
    expect(await declareDestination(client, OFFICE)).toBe('updated');
  });

  it('trims the address', async () => {
    const { client, uid } = await driver('jny-trim');
    await call(client, 'declareDestination', {
      destination: { ...OFFICE, formattedAddress: '  Canary Wharf  ' },
    });
    const id = await currentJourneyId(uid);
    expect((await journeyDoc(id))?.destination).toMatchObject({ formattedAddress: 'Canary Wharf' });
  });

  it('ignores anything else in the request', async () => {
    const { client, uid } = await driver('jny-extra');
    await call(client, 'declareDestination', {
      destination: { ...OFFICE, status: 'ACTIVE', driverId: 'someone-else' },
      status: 'ACTIVE',
      driverId: 'someone-else',
      availableSeats: 6,
      maxDetourMinutes: 99,
    });
    const id = await currentJourneyId(uid);
    expect(await journeyDoc(id)).toMatchObject({
      driverId: uid,
      status: 'DRAFT',
      availableSeats: null,
      maxDetourMinutes: null,
    });
    expect((await journeyDoc(id))?.destination).toEqual(OFFICE);
  });

  it.each([
    ['a latitude above 90', { ...OFFICE, latitude: 91 }],
    ['a latitude below -90', { ...OFFICE, latitude: -91 }],
    ['a longitude above 180', { ...OFFICE, longitude: 181 }],
    ['a longitude below -180', { ...OFFICE, longitude: -181 }],
    ['coordinates as text', { ...OFFICE, latitude: '51.5' }],
    ['a blank address', { ...OFFICE, formattedAddress: '   ' }],
    ['an oversized address', { ...OFFICE, formattedAddress: 'x'.repeat(301) }],
    ['an empty place ID', { ...OFFICE, placeId: '' }],
    ['no coordinates', { formattedAddress: 'Somewhere' }],
    ['nothing', null],
  ])('rejects %s', async (_label, destination) => {
    const { client, uid } = await driver('jny-invalid');
    await expect(call(client, 'declareDestination', { destination })).rejects.toMatchObject({
      code: 'functions/invalid-argument',
    });
    expect((await driverDoc(uid))?.currentJourneyId).toBeNull();
    expect(await journeysOf(uid)).toHaveLength(0);
  });

  it('gives each driver their own journey', async () => {
    const first = await driver('jny-first');
    const second = await driver('jny-second');
    await declareDestination(first.client, OFFICE);
    await declareDestination(second.client, HOME);

    const firstId = await currentJourneyId(first.uid);
    const secondId = await currentJourneyId(second.uid);
    expect(firstId).not.toBe(secondId);
    expect((await journeyDoc(firstId))?.destination).toEqual(OFFICE);
    expect((await journeyDoc(secondId))?.destination).toEqual(HOME);
  });

  it('never starts two journeys for one driver, even when asked twice at once', async () => {
    const { client, uid } = await driver('jny-race');
    const results = await Promise.allSettled([
      declareDestination(client, OFFICE),
      declareDestination(client, HOME),
    ]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

    expect(await journeysOf(uid)).toHaveLength(1);
    const id = await currentJourneyId(uid);
    expect([OFFICE, HOME]).toContainEqual((await journeyDoc(id))?.destination);
  });

  it('starts a fresh journey when the one the driver points at is gone', async () => {
    const { client, uid } = await driver('jny-stale');
    await declareDestination(client, OFFICE);
    const oldId = await currentJourneyId(uid);
    await admin().firestore.doc(`driverJourneys/${oldId}`).delete();

    expect(await declareDestination(client, HOME)).toBe('created');
    const newId = await currentJourneyId(uid);
    expect(newId).not.toBe(oldId);
    expect((await journeyDoc(newId))?.destination).toEqual(HOME);
  });

  it('refuses to change a journey that has moved past draft', async () => {
    const { client, uid } = await driver('jny-active');
    await declareDestination(client, OFFICE);
    const id = await currentJourneyId(uid);
    await admin().firestore.doc(`driverJourneys/${id}`).update({ status: 'ACTIVE' });

    await expect(call(client, 'declareDestination', { destination: HOME })).rejects.toMatchObject({
      code: 'functions/failed-precondition',
    });
    expect((await journeyDoc(id))?.destination).toEqual(OFFICE);
  });

  it('refuses when the driver points at a journey that belongs to someone else', async () => {
    const mine = await driver('jny-mine');
    const theirs = await driver('jny-theirs');
    await declareDestination(theirs.client, OFFICE);
    const theirId = await currentJourneyId(theirs.uid);
    await admin().firestore.doc(`drivers/${mine.uid}`).update({ currentJourneyId: theirId });

    await expect(
      call(mine.client, 'declareDestination', { destination: HOME }),
    ).rejects.toMatchObject({ code: 'functions/failed-precondition' });
    expect((await journeyDoc(theirId))?.destination).toEqual(OFFICE);
  });
});

describe('who may declare a destination', () => {
  it('refuses callers who are not verified drivers', async () => {
    await expect(
      call(createClient(), 'declareDestination', { destination: OFFICE }),
    ).rejects.toMatchObject({ code: 'functions/unauthenticated' });

    const callers = [
      await person('PASSENGER', 'jny-pass'),
      await person('DRIVER', 'jny-unv', false),
    ];
    for (const caller of callers) {
      await expect(
        call(caller.client, 'declareDestination', { destination: OFFICE }),
      ).rejects.toMatchObject({ code: 'functions/permission-denied' });
    }
  });

  it('refuses a driver with no vehicle, and a suspended driver', async () => {
    const noVehicle = await person('DRIVER', 'jny-novehicle');
    let failure;
    try {
      await declareDestination(noVehicle.client, OFFICE);
    } catch (error) {
      failure = describeAuthError(error);
    }
    expect(failure?.kind).toBe('permission');
    expect(await journeysOf(noVehicle.uid)).toHaveLength(0);

    const suspended = await driver('jny-suspended');
    await admin().firestore.doc(`users/${suspended.uid}`).update({ status: 'SUSPENDED' });
    await expect(
      call(suspended.client, 'declareDestination', { destination: OFFICE }),
    ).rejects.toMatchObject({ code: 'functions/failed-precondition' });
    expect(await journeysOf(suspended.uid)).toHaveLength(0);
  });
});

describe('the destination and going online', () => {
  async function readyExceptDestination(prefix: string) {
    const { client, uid } = await driver(prefix);
    await setVehicleCapacity(client, 4);
    await admin().firestore.doc(`drivers/${uid}`).update({ verificationStatus: 'VERIFIED' });
    await admin().firestore.doc(`vehicles/${uid}`).update({ verificationStatus: 'VERIFIED' });
    return { client, uid };
  }

  it('is needed to go online, and then allows it', async () => {
    const { client, uid } = await readyExceptDestination('jny-online');
    await expect(call(client, 'setAvailability', { status: 'ONLINE' })).rejects.toMatchObject({
      code: 'functions/failed-precondition',
      details: { unmet: ['destinationDeclared'] },
    });
    expect((await driverDoc(uid))?.availabilityStatus).toBe('OFFLINE');

    await declareDestination(client, OFFICE);
    expect(await setAvailability(client, 'ONLINE')).toBe('updated');
  });

  it('can be changed while online, and the driver stays online', async () => {
    const { client, uid } = await readyExceptDestination('jny-online-change');
    await declareDestination(client, OFFICE);
    await setAvailability(client, 'ONLINE');

    expect(await declareDestination(client, HOME)).toBe('updated');
    expect((await driverDoc(uid))?.availabilityStatus).toBe('ONLINE');
  });

  it("does not count a journey without a destination, or someone else's journey", async () => {
    const { client, uid } = await readyExceptDestination('jny-online-bad');
    await declareDestination(client, OFFICE);
    const id = await currentJourneyId(uid);

    await admin().firestore.doc(`driverJourneys/${id}`).update({ destination: null });
    await expect(call(client, 'setAvailability', { status: 'ONLINE' })).rejects.toMatchObject({
      code: 'functions/failed-precondition',
      details: { unmet: ['destinationDeclared'] },
    });

    await admin()
      .firestore.doc(`driverJourneys/${id}`)
      .update({ destination: OFFICE, driverId: 'other' });
    await expect(call(client, 'setAvailability', { status: 'ONLINE' })).rejects.toMatchObject({
      code: 'functions/failed-precondition',
      details: { unmet: ['destinationDeclared'] },
    });
  });
});

describe('reading a journey as the driver (real auth tokens)', () => {
  it('follows the journey live', async () => {
    const { client, uid } = await driver('jny-live');
    await declareDestination(client, OFFICE);
    const id = await currentJourneyId(uid);

    const snapshots: JourneySnapshot[] = [];
    const unsubscribe = subscribeToJourney(
      client,
      id,
      (snapshot) => snapshots.push(snapshot),
      (error) => {
        throw error;
      },
    );
    try {
      await expect
        .poll(() => snapshots.at(-1))
        .toEqual({ status: 'ready', journey: { status: 'DRAFT', destination: OFFICE } });

      await declareDestination(client, HOME);
      await expect
        .poll(() => snapshots.at(-1))
        .toEqual({ status: 'ready', journey: { status: 'DRAFT', destination: HOME } });
    } finally {
      unsubscribe();
    }
  });

  it('keeps journeys private and refuses every direct client write', async () => {
    const first = await driver('jny-priv-a');
    const second = await driver('jny-priv-b');
    const passenger = await person('PASSENGER', 'jny-priv-p');
    await declareDestination(first.client, OFFICE);
    const id = await currentJourneyId(first.uid);

    expect((await getDoc(doc(first.client.db, `driverJourneys/${id}`))).get('status')).toBe(
      'DRAFT',
    );
    for (const other of [second, passenger]) {
      await expect(getDoc(doc(other.client.db, `driverJourneys/${id}`))).rejects.toMatchObject({
        code: 'permission-denied',
      });
    }

    const own = doc(first.client.db, `driverJourneys/${id}`);
    await expect(updateDoc(own, { destination: HOME })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(updateDoc(own, { status: 'ACTIVE' })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(
      setDoc(doc(first.client.db, 'driverJourneys/made-up'), {
        driverId: first.uid,
        destination: HOME,
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      updateDoc(doc(first.client.db, `drivers/${first.uid}`), { currentJourneyId: 'elsewhere' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await journeyDoc(id))?.destination).toEqual(OFFICE);
  });
});
