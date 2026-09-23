import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  declareDestination,
  describeAuthError,
  saveVehicle,
  setAvailability,
  setJourneyDetour,
  setJourneyOrigin,
  setJourneySeats,
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
const ORIGIN = { latitude: 51.4545, longitude: -2.5879 };
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

describe('setJourneySeats: seats on offer (functions + firestore emulators)', () => {
  /** A driver with a vehicle of the given passenger seats and a destination. */
  async function driverWithJourney(prefix: string, capacity = 4) {
    const { client, uid } = await driver(prefix);
    await setVehicleCapacity(client, capacity);
    await declareDestination(client, OFFICE);
    return { client, uid, id: await currentJourneyId(uid) };
  }
  const seatsCall = (client: Client, availableSeats: unknown, extra: object = {}) =>
    call(client, 'setJourneySeats', { availableSeats, ...extra });

  it('sets the seats on the journey and does nothing when they are unchanged', async () => {
    const { client, id } = await driverWithJourney('seats-set');
    expect((await journeyDoc(id))?.availableSeats).toBeNull();

    expect(await setJourneySeats(client, 3)).toBe('updated');
    expect((await journeyDoc(id))?.availableSeats).toBe(3);

    expect(await setJourneySeats(client, 3)).toBe('unchanged');
    expect(await setJourneySeats(client, 1)).toBe('updated');
    expect((await journeyDoc(id))?.availableSeats).toBe(1);
  });

  it('accepts every number from one up to the vehicle capacity', async () => {
    const { client, id } = await driverWithJourney('seats-range', 6);
    for (const seats of [1, 2, 3, 4, 5, 6]) {
      await setJourneySeats(client, seats);
      expect((await journeyDoc(id))?.availableSeats).toBe(seats);
    }
  });

  it('keeps the rest of the journey and does not touch the vehicle', async () => {
    const { client, uid, id } = await driverWithJourney('seats-rest');
    await setJourneySeats(client, 2);

    expect(await journeyDoc(id)).toMatchObject({
      driverId: uid,
      destination: OFFICE,
      origin: null,
      status: 'DRAFT',
      maxDetourMinutes: null,
    });
    const vehicle = (await admin().firestore.doc(`vehicles/${uid}`).get()).data();
    expect(vehicle).toMatchObject({ seatCapacity: 4, availableSeats: null });
    expect(await createdAudit(id)).toHaveLength(1);
  });

  it('keeps the seats when the destination changes', async () => {
    const { client, id } = await driverWithJourney('seats-dest');
    await setJourneySeats(client, 2);
    await declareDestination(client, HOME);
    expect((await journeyDoc(id))?.availableSeats).toBe(2);
  });

  it('refuses more seats than the vehicle holds', async () => {
    const { client, id } = await driverWithJourney('seats-over', 3);
    await setJourneySeats(client, 2);

    await expect(seatsCall(client, 4)).rejects.toMatchObject({
      code: 'functions/invalid-argument',
    });
    expect((await journeyDoc(id))?.availableSeats).toBe(2);
  });

  it.each([
    ['zero', 0],
    ['a negative number', -1],
    ['more than any vehicle', 7],
    ['a fraction', 2.5],
    ['text', '2'],
    ['nothing', null],
  ])('rejects %s', async (_label, availableSeats) => {
    const { client, id } = await driverWithJourney('seats-invalid', 6);
    await expect(seatsCall(client, availableSeats)).rejects.toMatchObject({
      code: 'functions/invalid-argument',
    });
    expect((await journeyDoc(id))?.availableSeats).toBeNull();
  });

  it('ignores anything else in the request', async () => {
    const { client, uid, id } = await driverWithJourney('seats-extra');
    await seatsCall(client, 2, {
      driverId: 'someone-else',
      status: 'ACTIVE',
      destination: HOME,
      origin: null,
      maxDetourMinutes: 99,
    });
    expect(await journeyDoc(id)).toMatchObject({
      driverId: uid,
      status: 'DRAFT',
      destination: OFFICE,
      origin: null,
      maxDetourMinutes: null,
      availableSeats: 2,
    });
  });

  it('needs a destination first, and the vehicle seats to be set', async () => {
    const noJourney = await driver('seats-nojourney');
    await setVehicleCapacity(noJourney.client, 4);
    await expect(seatsCall(noJourney.client, 2)).rejects.toMatchObject({
      code: 'functions/failed-precondition',
    });
    let failure;
    try {
      await setJourneySeats(noJourney.client, 2);
    } catch (error) {
      failure = describeAuthError(error);
    }
    expect(failure?.kind).toBe('permission');

    const noCapacity = await driver('seats-nocapacity');
    await declareDestination(noCapacity.client, OFFICE);
    await expect(seatsCall(noCapacity.client, 2)).rejects.toMatchObject({
      code: 'functions/failed-precondition',
    });
    const id = await currentJourneyId(noCapacity.uid);
    expect((await journeyDoc(id))?.availableSeats).toBeNull();
  });

  it('refuses to change a journey that has moved past draft', async () => {
    const { client, id } = await driverWithJourney('seats-active');
    await setJourneySeats(client, 2);
    await admin().firestore.doc(`driverJourneys/${id}`).update({ status: 'ACTIVE' });

    await expect(seatsCall(client, 3)).rejects.toMatchObject({
      code: 'functions/failed-precondition',
    });
    expect((await journeyDoc(id))?.availableSeats).toBe(2);
  });

  it("refuses when the driver points at someone else's journey, and a suspended driver", async () => {
    const mine = await driverWithJourney('seats-mine');
    const theirs = await driverWithJourney('seats-theirs');
    await admin().firestore.doc(`drivers/${mine.uid}`).update({ currentJourneyId: theirs.id });
    await expect(seatsCall(mine.client, 2)).rejects.toMatchObject({
      code: 'functions/failed-precondition',
    });
    expect((await journeyDoc(theirs.id))?.availableSeats).toBeNull();

    const suspended = await driverWithJourney('seats-suspended');
    await admin().firestore.doc(`users/${suspended.uid}`).update({ status: 'SUSPENDED' });
    await expect(seatsCall(suspended.client, 2)).rejects.toMatchObject({
      code: 'functions/failed-precondition',
    });
  });

  it('refuses callers who are not verified drivers', async () => {
    await expect(seatsCall(createClient(), 2)).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });

    const callers = [
      await person('PASSENGER', 'seats-pass'),
      await person('DRIVER', 'seats-unv', false),
    ];
    for (const caller of callers) {
      await expect(seatsCall(caller.client, 2)).rejects.toMatchObject({
        code: 'functions/permission-denied',
      });
    }
  });

  it('follows the seats live', async () => {
    const { client, id } = await driverWithJourney('seats-live');
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
      await setJourneySeats(client, 3);
      await expect
        .poll(() => snapshots.at(-1))
        .toEqual({
          status: 'ready',
          journey: {
            status: 'DRAFT',
            destination: OFFICE,
            origin: null,
            availableSeats: 3,
            maxDetourMinutes: null,
            maxDetourDistance: null,
            matchedTripRequestIds: [],
          },
        });
    } finally {
      unsubscribe();
    }
  });

  it('refuses a direct client write of the seats', async () => {
    const { client, id } = await driverWithJourney('seats-direct');
    await expect(
      updateDoc(doc(client.db, `driverJourneys/${id}`), { availableSeats: 4 }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await journeyDoc(id))?.availableSeats).toBeNull();
  });
});

describe('seats on offer and going online', () => {
  async function readyDriver(prefix: string) {
    const { client, uid } = await driver(prefix);
    await setVehicleCapacity(client, 4);
    await admin().firestore.doc(`drivers/${uid}`).update({ verificationStatus: 'VERIFIED' });
    await admin().firestore.doc(`vehicles/${uid}`).update({ verificationStatus: 'VERIFIED' });
    await declareDestination(client, OFFICE);
    await setJourneyOrigin(client, ORIGIN);
    return { client, uid, id: await currentJourneyId(uid) };
  }

  it('is needed to go online, and then allows it', async () => {
    const { client, id } = await readyDriver('seats-online');
    await admin()
      .firestore.doc(`driverJourneys/${id}`)
      .update({ maxDetourMinutes: 10, maxDetourDistance: 5 });
    await expect(call(client, 'setAvailability', { status: 'ONLINE' })).rejects.toMatchObject({
      code: 'functions/failed-precondition',
      details: { unmet: ['seatsOffered'] },
    });

    await setJourneySeats(client, 2);
    expect(await setAvailability(client, 'ONLINE')).toBe('updated');
  });

  it('does not count seats the vehicle cannot hold, or none at all', async () => {
    const { client, id } = await readyDriver('seats-online-bad');
    await admin()
      .firestore.doc(`driverJourneys/${id}`)
      .update({ maxDetourMinutes: 10, maxDetourDistance: 5 });
    for (const availableSeats of [5, 0, null, 2.5]) {
      await admin().firestore.doc(`driverJourneys/${id}`).update({ availableSeats });
      await expect(call(client, 'setAvailability', { status: 'ONLINE' })).rejects.toMatchObject({
        code: 'functions/failed-precondition',
        details: { unmet: ['seatsOffered'] },
      });
    }
  });

  it('can be changed while the driver is online, and the driver stays online', async () => {
    const { client, uid } = await readyDriver('seats-online-change');
    await setJourneyDetour(client, 10, 5);
    await setJourneySeats(client, 2);
    await setAvailability(client, 'ONLINE');

    expect(await setJourneySeats(client, 3)).toBe('updated');
    expect((await driverDoc(uid))?.availabilityStatus).toBe('ONLINE');
  });
});

describe('setJourneyDetour: maximum detour (functions + firestore emulators)', () => {
  /** A driver with a vehicle and a destination, so a journey exists to put limits on. */
  async function driverWithJourney(prefix: string) {
    const { client, uid } = await driver(prefix);
    await declareDestination(client, OFFICE);
    return { client, uid, id: await currentJourneyId(uid) };
  }
  const detourCall = (client: Client, input: unknown) => call(client, 'setJourneyDetour', input);

  it('sets both limits on the journey and does nothing when they are unchanged', async () => {
    const { client, id } = await driverWithJourney('detour-set');
    expect(await journeyDoc(id)).toMatchObject({ maxDetourMinutes: null, maxDetourDistance: null });

    expect(await setJourneyDetour(client, 10, 5)).toBe('updated');
    expect(await journeyDoc(id)).toMatchObject({ maxDetourMinutes: 10, maxDetourDistance: 5 });

    expect(await setJourneyDetour(client, 10, 5)).toBe('unchanged');
    expect(await setJourneyDetour(client, 10, 8)).toBe('updated');
    expect(await setJourneyDetour(client, 15, 8)).toBe('updated');
    expect(await journeyDoc(id)).toMatchObject({ maxDetourMinutes: 15, maxDetourDistance: 8 });
  });

  it('accepts the edges of both ranges', async () => {
    const { client, id } = await driverWithJourney('detour-edges');
    for (const [minutes, km] of [
      [1, 1],
      [60, 30],
    ] as const) {
      await setJourneyDetour(client, minutes, km);
      expect(await journeyDoc(id)).toMatchObject({
        maxDetourMinutes: minutes,
        maxDetourDistance: km,
      });
    }
  });

  it('keeps the rest of the journey, and leaves the driver profile fields alone', async () => {
    const { client, uid, id } = await driverWithJourney('detour-rest');
    await setJourneyDetour(client, 20, 10);

    expect(await journeyDoc(id)).toMatchObject({
      driverId: uid,
      destination: OFFICE,
      origin: null,
      status: 'DRAFT',
      availableSeats: null,
    });
    expect(await driverDoc(uid)).toMatchObject({ maxDetourMinutes: null, maxDetourDistance: null });
    expect(await createdAudit(id)).toHaveLength(1);
  });

  it('keeps the limits when the destination changes, and does not touch the seats', async () => {
    const { client, id } = await driverWithJourney('detour-dest');
    await setJourneyDetour(client, 10, 5);
    await declareDestination(client, HOME);
    expect(await journeyDoc(id)).toMatchObject({
      maxDetourMinutes: 10,
      maxDetourDistance: 5,
      availableSeats: null,
    });
  });

  it.each([
    ['zero minutes', { maxDetourMinutes: 0, maxDetourDistance: 5 }],
    ['more than 60 minutes', { maxDetourMinutes: 61, maxDetourDistance: 5 }],
    ['zero kilometres', { maxDetourMinutes: 10, maxDetourDistance: 0 }],
    ['more than 30 kilometres', { maxDetourMinutes: 10, maxDetourDistance: 31 }],
    ['fractions', { maxDetourMinutes: 7.5, maxDetourDistance: 2.5 }],
    ['negative numbers', { maxDetourMinutes: -5, maxDetourDistance: -1 }],
    ['text', { maxDetourMinutes: '10', maxDetourDistance: '5' }],
    ['only the minutes', { maxDetourMinutes: 10 }],
    ['only the kilometres', { maxDetourDistance: 5 }],
    ['nothing', {}],
  ])('rejects %s', async (_label, input) => {
    const { client, id } = await driverWithJourney('detour-invalid');
    await expect(detourCall(client, input)).rejects.toMatchObject({
      code: 'functions/invalid-argument',
    });
    expect(await journeyDoc(id)).toMatchObject({ maxDetourMinutes: null, maxDetourDistance: null });
  });

  it('ignores anything else in the request', async () => {
    const { client, uid, id } = await driverWithJourney('detour-extra');
    await detourCall(client, {
      maxDetourMinutes: 10,
      maxDetourDistance: 5,
      driverId: 'someone-else',
      status: 'ACTIVE',
      availableSeats: 6,
      destination: HOME,
      origin: null,
    });
    expect(await journeyDoc(id)).toMatchObject({
      driverId: uid,
      status: 'DRAFT',
      destination: OFFICE,
      origin: null,
      availableSeats: null,
      maxDetourMinutes: 10,
      maxDetourDistance: 5,
    });
  });

  it('needs a destination first', async () => {
    const noJourney = await driver('detour-nojourney');
    await expect(
      detourCall(noJourney.client, { maxDetourMinutes: 10, maxDetourDistance: 5 }),
    ).rejects.toMatchObject({ code: 'functions/failed-precondition' });
    let failure;
    try {
      await setJourneyDetour(noJourney.client, 10, 5);
    } catch (error) {
      failure = describeAuthError(error);
    }
    expect(failure?.kind).toBe('permission');
    expect(await journeysOf(noJourney.uid)).toHaveLength(0);
  });

  it('refuses to change a journey that has moved past draft', async () => {
    const { client, id } = await driverWithJourney('detour-active');
    await setJourneyDetour(client, 10, 5);
    await admin().firestore.doc(`driverJourneys/${id}`).update({ status: 'ACTIVE' });

    await expect(
      detourCall(client, { maxDetourMinutes: 20, maxDetourDistance: 10 }),
    ).rejects.toMatchObject({ code: 'functions/failed-precondition' });
    expect(await journeyDoc(id)).toMatchObject({ maxDetourMinutes: 10, maxDetourDistance: 5 });
  });

  it("refuses when the driver points at someone else's journey, and a suspended driver", async () => {
    const mine = await driverWithJourney('detour-mine');
    const theirs = await driverWithJourney('detour-theirs');
    await admin().firestore.doc(`drivers/${mine.uid}`).update({ currentJourneyId: theirs.id });
    await expect(
      detourCall(mine.client, { maxDetourMinutes: 10, maxDetourDistance: 5 }),
    ).rejects.toMatchObject({ code: 'functions/failed-precondition' });
    expect(await journeyDoc(theirs.id)).toMatchObject({ maxDetourMinutes: null });

    const suspended = await driverWithJourney('detour-suspended');
    await admin().firestore.doc(`users/${suspended.uid}`).update({ status: 'SUSPENDED' });
    await expect(
      detourCall(suspended.client, { maxDetourMinutes: 10, maxDetourDistance: 5 }),
    ).rejects.toMatchObject({ code: 'functions/failed-precondition' });
  });

  it('refuses callers who are not verified drivers', async () => {
    const input = { maxDetourMinutes: 10, maxDetourDistance: 5 };
    await expect(detourCall(createClient(), input)).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });
    const callers = [
      await person('PASSENGER', 'detour-pass'),
      await person('DRIVER', 'detour-unv', false),
    ];
    for (const caller of callers) {
      await expect(detourCall(caller.client, input)).rejects.toMatchObject({
        code: 'functions/permission-denied',
      });
    }
  });

  it('follows the limits live', async () => {
    const { client, id } = await driverWithJourney('detour-live');
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
      await setJourneyDetour(client, 15, 10);
      await expect
        .poll(() => snapshots.at(-1))
        .toEqual({
          status: 'ready',
          journey: {
            status: 'DRAFT',
            destination: OFFICE,
            origin: null,
            availableSeats: null,
            maxDetourMinutes: 15,
            maxDetourDistance: 10,
            matchedTripRequestIds: [],
          },
        });
    } finally {
      unsubscribe();
    }
  });

  it('refuses a direct client write of the limits', async () => {
    const { client, id } = await driverWithJourney('detour-direct');
    await expect(
      updateDoc(doc(client.db, `driverJourneys/${id}`), { maxDetourMinutes: 10 }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await journeyDoc(id))?.maxDetourMinutes).toBeNull();
  });
});

describe('the maximum detour and going online', () => {
  async function readyDriver(prefix: string) {
    const { client, uid } = await driver(prefix);
    await setVehicleCapacity(client, 4);
    await admin().firestore.doc(`drivers/${uid}`).update({ verificationStatus: 'VERIFIED' });
    await admin().firestore.doc(`vehicles/${uid}`).update({ verificationStatus: 'VERIFIED' });
    await declareDestination(client, OFFICE);
    await setJourneyOrigin(client, ORIGIN);
    await setJourneySeats(client, 2);
    return { client, uid, id: await currentJourneyId(uid) };
  }

  it('is needed to go online, and then allows it', async () => {
    const { client } = await readyDriver('detour-online');
    await expect(call(client, 'setAvailability', { status: 'ONLINE' })).rejects.toMatchObject({
      code: 'functions/failed-precondition',
      details: { unmet: ['detourSet'] },
    });

    await setJourneyDetour(client, 10, 5);
    expect(await setAvailability(client, 'ONLINE')).toBe('updated');
  });

  it('needs both limits, each within its range', async () => {
    const { client, id } = await readyDriver('detour-online-bad');
    const journey = admin().firestore.doc(`driverJourneys/${id}`);
    for (const [maxDetourMinutes, maxDetourDistance] of [
      [10, null],
      [null, 5],
      [0, 5],
      [61, 5],
      [10, 0],
      [10, 31],
      [7.5, 5],
      [10, 2.5],
    ]) {
      await journey.update({ maxDetourMinutes, maxDetourDistance });
      await expect(call(client, 'setAvailability', { status: 'ONLINE' })).rejects.toMatchObject({
        code: 'functions/failed-precondition',
        details: { unmet: ['detourSet'] },
      });
    }
  });

  it("does not count someone else's journey", async () => {
    const { client, id } = await readyDriver('detour-online-other');
    await setJourneyDetour(client, 10, 5);
    await admin().firestore.doc(`driverJourneys/${id}`).update({ driverId: 'other' });
    await expect(call(client, 'setAvailability', { status: 'ONLINE' })).rejects.toMatchObject({
      code: 'functions/failed-precondition',
      details: { unmet: ['destinationDeclared', 'originSet', 'seatsOffered', 'detourSet'] },
    });
  });

  it('can be changed while the driver is online, and the driver stays online', async () => {
    const { client, uid } = await readyDriver('detour-online-change');
    await setJourneyDetour(client, 10, 5);
    await setAvailability(client, 'ONLINE');

    expect(await setJourneyDetour(client, 20, 10)).toBe('updated');
    expect((await driverDoc(uid))?.availabilityStatus).toBe('ONLINE');
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
      details: { unmet: ['destinationDeclared', 'originSet', 'seatsOffered', 'detourSet'] },
    });
    expect((await driverDoc(uid))?.availabilityStatus).toBe('OFFLINE');

    await declareDestination(client, OFFICE);
    await setJourneyOrigin(client, ORIGIN);
    await setJourneySeats(client, 2);
    await setJourneyDetour(client, 10, 5);
    expect(await setAvailability(client, 'ONLINE')).toBe('updated');
  });

  it('can be changed while online, and the driver stays online', async () => {
    const { client, uid } = await readyExceptDestination('jny-online-change');
    await declareDestination(client, OFFICE);
    await setJourneyOrigin(client, ORIGIN);
    await setJourneySeats(client, 2);
    await setJourneyDetour(client, 10, 5);
    await setAvailability(client, 'ONLINE');

    expect(await declareDestination(client, HOME)).toBe('updated');
    expect((await driverDoc(uid))?.availabilityStatus).toBe('ONLINE');
  });

  it("does not count a journey without a destination, or someone else's journey", async () => {
    const { client, uid } = await readyExceptDestination('jny-online-bad');
    await declareDestination(client, OFFICE);
    await setJourneyOrigin(client, ORIGIN);
    await setJourneySeats(client, 2);
    await setJourneyDetour(client, 10, 5);
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
      details: { unmet: ['destinationDeclared', 'originSet', 'seatsOffered', 'detourSet'] },
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
        .toEqual({
          status: 'ready',
          journey: {
            status: 'DRAFT',
            destination: OFFICE,
            origin: null,
            availableSeats: null,
            maxDetourMinutes: null,
            maxDetourDistance: null,
            matchedTripRequestIds: [],
          },
        });

      await declareDestination(client, HOME);
      await expect
        .poll(() => snapshots.at(-1))
        .toEqual({
          status: 'ready',
          journey: {
            status: 'DRAFT',
            destination: HOME,
            origin: null,
            availableSeats: null,
            maxDetourMinutes: null,
            maxDetourDistance: null,
            matchedTripRequestIds: [],
          },
        });
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
        origin: null,
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      updateDoc(doc(first.client.db, `drivers/${first.uid}`), { currentJourneyId: 'elsewhere' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await journeyDoc(id))?.destination).toEqual(OFFICE);
  });
});
