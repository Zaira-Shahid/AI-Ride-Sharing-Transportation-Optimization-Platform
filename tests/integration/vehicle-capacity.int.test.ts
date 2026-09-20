import { doc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import {
  declareDestination,
  describeAuthError,
  saveVehicle,
  setJourneySeats,
  setVehicleCapacity,
  subscribeToVehicle,
  type VehicleSnapshot,
} from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

const DETAILS = { type: 'CAR', make: 'Toyota', model: 'Corolla' } as const;
const OFFICE = {
  latitude: 51.5049,
  longitude: -0.0195,
  formattedAddress: '1 Canada Square, London E14 5AB, UK',
  placeId: 'place-office',
};
let plateCounter = 0;
const uniquePlate = () => `CAP-${Date.now() % 100000}-${plateCounter++}`;

function callSetCapacity(client: Client, data: unknown) {
  return httpsCallable(client.functions, 'setVehicleCapacity')(data);
}

async function person(role: 'DRIVER' | 'PASSENGER', prefix: string, verified = true) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
  if (verified) await verifyEmail(user, email);
  else await user.getIdToken(true);
  return { client, uid };
}

/** A verified driver who has already added a vehicle. */
async function driverWithVehicle(prefix: string) {
  const { client, uid } = await person('DRIVER', prefix);
  await saveVehicle(client, { ...DETAILS, plateNumber: uniquePlate() });
  return { client, uid };
}

const vehicleRef = (uid: string) => admin().firestore.doc(`vehicles/${uid}`);
const stored = async (uid: string) => (await vehicleRef(uid).get()).data();
const capacityAudit = async (uid: string) =>
  (
    await admin()
      .firestore.collection('auditLogs')
      .where('entity', '==', `vehicles/${uid}`)
      .where('action', '==', 'VEHICLE_CAPACITY_CHANGED')
      .get()
  ).docs;

describe('setVehicleCapacity: setting seats (functions + firestore emulators)', () => {
  it('sets the passenger seats and audits the first change', async () => {
    const { client, uid } = await driverWithVehicle('cap-set');
    expect((await stored(uid))?.seatCapacity).toBeNull();

    expect(await setVehicleCapacity(client, 4)).toBe('updated');
    expect(await stored(uid)).toMatchObject({ seatCapacity: 4, availableSeats: null });

    const entries = await capacityAudit(uid);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data()).toMatchObject({
      actor: uid,
      previousState: { seatCapacity: null, verificationStatus: 'PENDING' },
      newState: { seatCapacity: 4, verificationStatus: 'PENDING' },
    });
  });

  it('accepts the whole allowed range', async () => {
    const { client, uid } = await driverWithVehicle('cap-range');
    for (const seats of [1, 6, 3]) {
      expect(await setVehicleCapacity(client, seats)).toBe('updated');
      expect((await stored(uid))?.seatCapacity).toBe(seats);
    }
  });

  it('writes nothing when the seats did not change', async () => {
    const { client, uid } = await driverWithVehicle('cap-same');
    await setVehicleCapacity(client, 4);
    await vehicleRef(uid).update({ verificationStatus: 'VERIFIED' });

    expect(await setVehicleCapacity(client, 4)).toBe('unchanged');
    expect((await stored(uid))?.verificationStatus).toBe('VERIFIED');
    expect(await capacityAudit(uid)).toHaveLength(1);
  });

  it.each([
    ['zero', 0],
    ['seven', 7],
    ['negative', -2],
    ['a fraction', 2.5],
    ['a string', '4'],
    ['null', null],
    ['nothing', undefined],
  ])('rejects %s seats', async (_label, seatCapacity) => {
    const { client, uid } = await driverWithVehicle('cap-invalid');
    await expect(callSetCapacity(client, { seatCapacity })).rejects.toMatchObject({
      code: 'functions/invalid-argument',
    });
    expect((await stored(uid))?.seatCapacity).toBeNull();
  });

  it('ignores anything else in the request', async () => {
    const { client, uid } = await driverWithVehicle('cap-extra');
    await callSetCapacity(client, {
      seatCapacity: 3,
      verificationStatus: 'VERIFIED',
      availableSeats: 6,
      plateNumber: 'HACK 1',
    });
    expect(await stored(uid)).toMatchObject({
      seatCapacity: 3,
      availableSeats: null,
      verificationStatus: 'PENDING',
    });
    expect((await stored(uid))?.plateNumber).not.toBe('HACK 1');
  });

  it('also refuses out-of-range values from the app helper before calling the server', async () => {
    const { client } = await driverWithVehicle('cap-helper');
    for (const seats of [0, 7, 2.5, null]) {
      let failure;
      try {
        await setVehicleCapacity(client, seats);
      } catch (error) {
        failure = describeAuthError(error);
      }
      expect(failure).toMatchObject({
        kind: 'validation',
        message: 'Choose between 1 and 6 passenger seats.',
      });
    }
  });
});

describe('setVehicleCapacity: verification and seats on offer', () => {
  it('sends a verified vehicle back to PENDING when seats go up', async () => {
    const { client, uid } = await driverWithVehicle('cap-up');
    await setVehicleCapacity(client, 3);
    await vehicleRef(uid).update({ verificationStatus: 'VERIFIED' });

    expect(await setVehicleCapacity(client, 5)).toBe('updated');
    expect((await stored(uid))?.verificationStatus).toBe('PENDING');
    const latest = (await capacityAudit(uid)).find(
      (entry) => entry.get('newState.seatCapacity') === 5,
    );
    expect(latest?.data()).toMatchObject({
      previousState: { seatCapacity: 3, verificationStatus: 'VERIFIED' },
      newState: { seatCapacity: 5, verificationStatus: 'PENDING' },
    });
  });

  it('keeps a verified vehicle verified when seats go down', async () => {
    const { client, uid } = await driverWithVehicle('cap-down');
    await setVehicleCapacity(client, 5);
    await vehicleRef(uid).update({ verificationStatus: 'VERIFIED' });

    expect(await setVehicleCapacity(client, 2)).toBe('updated');
    expect((await stored(uid))?.verificationStatus).toBe('VERIFIED');
  });

  it('treats seats that were never reviewed as an increase', async () => {
    const { client, uid } = await driverWithVehicle('cap-first');
    await vehicleRef(uid).update({ verificationStatus: 'VERIFIED' });

    await setVehicleCapacity(client, 1);
    expect((await stored(uid))?.verificationStatus).toBe('PENDING');
  });

  it('does not clear a rejection when seats go down', async () => {
    const { client, uid } = await driverWithVehicle('cap-rejected');
    await setVehicleCapacity(client, 4);
    await vehicleRef(uid).update({ verificationStatus: 'REJECTED' });

    await setVehicleCapacity(client, 3);
    expect((await stored(uid))?.verificationStatus).toBe('REJECTED');
  });

  it('never leaves more seats on offer than the vehicle holds', async () => {
    const { client, uid } = await driverWithVehicle('cap-clamp');
    await setVehicleCapacity(client, 6);
    await vehicleRef(uid).update({ availableSeats: 5 });

    await setVehicleCapacity(client, 3);
    expect(await stored(uid)).toMatchObject({ seatCapacity: 3, availableSeats: 3 });

    await setVehicleCapacity(client, 2);
    expect((await stored(uid))?.availableSeats).toBe(2);

    await setVehicleCapacity(client, 5);
    expect((await stored(uid))?.availableSeats).toBe(2);
  });

  it('lowers the seats on the journey when the vehicle gets fewer seats', async () => {
    const { client, uid } = await driverWithVehicle('cap-journey');
    await setVehicleCapacity(client, 6);
    await declareDestination(client, OFFICE);
    await setJourneySeats(client, 5);
    const journeyId = (await admin().firestore.doc(`drivers/${uid}`).get()).get('currentJourneyId');
    const journeySeats = async () =>
      (await admin().firestore.doc(`driverJourneys/${journeyId}`).get()).get('availableSeats');

    await setVehicleCapacity(client, 3);
    expect(await journeySeats()).toBe(3);

    // Fewer seats than are offered is never touched, and raising the capacity gives nothing back.
    await setJourneySeats(client, 2);
    await setVehicleCapacity(client, 2);
    expect(await journeySeats()).toBe(2);
    await setVehicleCapacity(client, 6);
    expect(await journeySeats()).toBe(2);
  });

  it('leaves a journey with no seats chosen yet alone', async () => {
    const { client, uid } = await driverWithVehicle('cap-journey-none');
    await setVehicleCapacity(client, 4);
    await declareDestination(client, OFFICE);
    const journeyId = (await admin().firestore.doc(`drivers/${uid}`).get()).get('currentJourneyId');

    await setVehicleCapacity(client, 2);
    const journey = await admin().firestore.doc(`driverJourneys/${journeyId}`).get();
    expect(journey.get('availableSeats')).toBeNull();
  });

  it('is not undone by editing the vehicle details', async () => {
    const { client, uid } = await driverWithVehicle('cap-edit');
    await setVehicleCapacity(client, 4);
    await saveVehicle(client, { ...DETAILS, make: 'Honda', plateNumber: uniquePlate() });
    expect(await stored(uid)).toMatchObject({ make: 'Honda', seatCapacity: 4 });
  });
});

describe('setVehicleCapacity: who may call it', () => {
  it('refuses callers who are not verified drivers', async () => {
    await expect(callSetCapacity(createClient(), { seatCapacity: 3 })).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });

    const passenger = await person('PASSENGER', 'cap-pass');
    await expect(callSetCapacity(passenger.client, { seatCapacity: 3 })).rejects.toMatchObject({
      code: 'functions/permission-denied',
    });

    const unverified = await person('DRIVER', 'cap-unverified', false);
    await expect(callSetCapacity(unverified.client, { seatCapacity: 3 })).rejects.toMatchObject({
      code: 'functions/permission-denied',
    });
  });

  it('refuses a driver who has no vehicle yet', async () => {
    const { client, uid } = await person('DRIVER', 'cap-novehicle');
    let failure;
    try {
      await setVehicleCapacity(client, 3);
    } catch (error) {
      failure = describeAuthError(error);
    }
    expect(failure?.kind).toBe('permission');
    expect(await stored(uid)).toBeUndefined();
  });

  it('refuses a suspended driver', async () => {
    const { client, uid } = await driverWithVehicle('cap-suspended');
    await admin().firestore.doc(`users/${uid}`).update({ status: 'SUSPENDED' });
    await expect(callSetCapacity(client, { seatCapacity: 3 })).rejects.toMatchObject({
      code: 'functions/failed-precondition',
    });
    expect((await stored(uid))?.seatCapacity).toBeNull();
  });

  it('only ever changes the caller own vehicle', async () => {
    const first = await driverWithVehicle('cap-mine');
    const second = await driverWithVehicle('cap-theirs');
    await callSetCapacity(first.client, { seatCapacity: 2, driverId: second.uid, uid: second.uid });
    expect((await stored(first.uid))?.seatCapacity).toBe(2);
    expect((await stored(second.uid))?.seatCapacity).toBeNull();
  });

  it('cannot be bypassed by writing the seats directly', async () => {
    const { client, uid } = await driverWithVehicle('cap-direct');
    await expect(
      updateDoc(doc(client.db, `vehicles/${uid}`), { seatCapacity: 6 }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await stored(uid))?.seatCapacity).toBeNull();
  });
});

describe('seats as the driver sees them', () => {
  it('follows the seats live', async () => {
    const { client, uid } = await driverWithVehicle('cap-live');
    const snapshots: VehicleSnapshot[] = [];
    const unsubscribe = subscribeToVehicle(
      client,
      uid,
      (snapshot) => snapshots.push(snapshot),
      (error) => {
        throw error;
      },
    );
    try {
      await expect
        .poll(() => snapshots.at(-1))
        .toMatchObject({ status: 'ready', vehicle: { seatCapacity: null } });

      await setVehicleCapacity(client, 4);
      await expect
        .poll(() => snapshots.at(-1))
        .toMatchObject({ status: 'ready', vehicle: { seatCapacity: 4 } });
    } finally {
      unsubscribe();
    }
  });
});
