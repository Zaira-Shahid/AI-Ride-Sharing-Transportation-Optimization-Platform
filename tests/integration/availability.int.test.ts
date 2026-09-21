import { doc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  describeAuthError,
  declareDestination,
  saveVehicle,
  setAvailability,
  setJourneyDetour,
  setJourneyOrigin,
  setJourneySeats,
  setVehicleCapacity,
  subscribeToDriverProfile,
  type DriverProfileSnapshot,
} from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

const OFFICE = {
  latitude: 51.5049,
  longitude: -0.0195,
  formattedAddress: '1 Canada Square, London E14 5AB, UK',
  placeId: 'place-office',
};
const ORIGIN = { latitude: 51.4545, longitude: -2.5879 };
let plateCounter = 0;
const uniquePlate = () => `AVL-${Date.now() % 100000}-${plateCounter++}`;

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

async function staff(prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await admin().auth.setCustomUserClaims(uid, { role: 'ADMIN' });
  await verifyEmail(user, email);
  return { client, uid };
}

const driverRef = (uid: string) => admin().firestore.doc(`drivers/${uid}`);
const vehicleRef = (uid: string) => admin().firestore.doc(`vehicles/${uid}`);
const driverDoc = async (uid: string) => (await driverRef(uid).get()).data();
const vehicleDoc = async (uid: string) => (await vehicleRef(uid).get()).data();
const offlineAudit = async (uid: string) =>
  (
    await admin()
      .firestore.collection('auditLogs')
      .where('entity', '==', `drivers/${uid}`)
      .where('action', '==', 'DRIVER_TAKEN_OFFLINE')
      .get()
  ).docs;

/** A driver with a vehicle and seats, still waiting for staff to verify either. */
async function driverWithVehicle(prefix: string) {
  const driver = await person('DRIVER', prefix);
  await saveVehicle(driver.client, {
    type: 'CAR',
    make: 'Toyota',
    model: 'Corolla',
    plateNumber: uniquePlate(),
  });
  await setVehicleCapacity(driver.client, 4);
  return driver;
}

/** A driver who meets every requirement to go online. */
async function eligibleDriver(prefix: string) {
  const driver = await driverWithVehicle(prefix);
  await driverRef(driver.uid).update({ verificationStatus: 'VERIFIED' });
  await vehicleRef(driver.uid).update({ verificationStatus: 'VERIFIED' });
  await declareDestination(driver.client, OFFICE);
  await setJourneyOrigin(driver.client, ORIGIN);
  await setJourneySeats(driver.client, 3);
  await setJourneyDetour(driver.client, 10, 5);
  return driver;
}

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject.');
}

// Plates are unique, so every test starts without vehicles.
beforeEach(async () => {
  const { firestore } = admin();
  await firestore.recursiveDelete(firestore.collection('vehicles'));
});

describe('setAvailability: going online and offline (functions + firestore emulators)', () => {
  it('lets an eligible driver go online and offline, recording when', async () => {
    const driver = await eligibleDriver('avl-toggle');
    expect((await driverDoc(driver.uid))?.availabilityChangedAt).toBeNull();

    expect(await setAvailability(driver.client, 'ONLINE')).toBe('updated');
    const online = await driverDoc(driver.uid);
    expect(online?.availabilityStatus).toBe('ONLINE');
    expect(online?.availabilityChangedAt).toBeDefined();
    expect(online?.availabilityChangedAt).not.toBeNull();

    expect(await setAvailability(driver.client, 'OFFLINE')).toBe('updated');
    expect((await driverDoc(driver.uid))?.availabilityStatus).toBe('OFFLINE');
  });

  it('changes nothing when the driver is already in that state', async () => {
    const driver = await eligibleDriver('avl-same');
    expect(await setAvailability(driver.client, 'OFFLINE')).toBe('unchanged');
    await setAvailability(driver.client, 'ONLINE');
    const before = (await driverDoc(driver.uid))?.availabilityChangedAt;

    expect(await setAvailability(driver.client, 'ONLINE')).toBe('unchanged');
    expect((await driverDoc(driver.uid))?.availabilityChangedAt).toEqual(before);
  });

  it('does not audit an ordinary toggle', async () => {
    const driver = await eligibleDriver('avl-noaudit');
    await setAvailability(driver.client, 'ONLINE');
    await setAvailability(driver.client, 'OFFLINE');
    expect(await offlineAudit(driver.uid)).toHaveLength(0);
  });

  it('leaves everything else on the driver profile alone', async () => {
    const driver = await eligibleDriver('avl-rest');
    await setAvailability(driver.client, 'ONLINE');
    expect(await driverDoc(driver.uid)).toMatchObject({
      verificationStatus: 'VERIFIED',
      rating: null,
      totalTrips: 0,
      maxDetourMinutes: null,
    });
  });

  it.each([
    ['a pending driver', 'driver', { verificationStatus: 'PENDING' }],
    ['a rejected driver', 'driver', { verificationStatus: 'REJECTED', verificationReason: 'No.' }],
    ['a pending vehicle', 'vehicle', { verificationStatus: 'PENDING' }],
    [
      'a rejected vehicle',
      'vehicle',
      { verificationStatus: 'REJECTED', verificationReason: 'No.' },
    ],
    ['a vehicle without seats', 'vehicle', { seatCapacity: null }],
  ] as const)('refuses %s', async (_label, which, change) => {
    const driver = await eligibleDriver('avl-refuse');
    await (which === 'driver' ? driverRef : vehicleRef)(driver.uid).update(change);

    const error = await failureOf(setAvailability(driver.client, 'ONLINE'));
    expect(describeAuthError(error).kind).toBe('permission');
    expect((await driverDoc(driver.uid))?.availabilityStatus).toBe('OFFLINE');
  });

  it('refuses a driver whose journey offers no seats, or more than the vehicle holds', async () => {
    const driver = await eligibleDriver('avl-noseats');
    const journeyId = (await driverDoc(driver.uid))?.currentJourneyId as string;
    const journey = admin().firestore.doc(`driverJourneys/${journeyId}`);

    for (const availableSeats of [null, 0, 5]) {
      await journey.update({ availableSeats });
      await expect(
        call(driver.client, 'setAvailability', { status: 'ONLINE' }),
      ).rejects.toMatchObject({
        code: 'functions/failed-precondition',
        details: { unmet: ['seatsOffered'] },
      });
    }
    expect((await driverDoc(driver.uid))?.availabilityStatus).toBe('OFFLINE');
  });

  it('refuses a driver whose journey has no valid detour limits', async () => {
    const driver = await eligibleDriver('avl-nodetour');
    const journeyId = (await driverDoc(driver.uid))?.currentJourneyId as string;
    const journey = admin().firestore.doc(`driverJourneys/${journeyId}`);

    for (const [maxDetourMinutes, maxDetourDistance] of [
      [null, null],
      [10, null],
      [null, 5],
      [0, 5],
      [10, 31],
    ]) {
      await journey.update({ maxDetourMinutes, maxDetourDistance });
      await expect(
        call(driver.client, 'setAvailability', { status: 'ONLINE' }),
      ).rejects.toMatchObject({
        code: 'functions/failed-precondition',
        details: { unmet: ['detourSet'] },
      });
    }
    expect((await driverDoc(driver.uid))?.availabilityStatus).toBe('OFFLINE');
  });

  it('says which requirements are missing', async () => {
    const driver = await person('DRIVER', 'avl-details');
    await expect(
      call(driver.client, 'setAvailability', { status: 'ONLINE' }),
    ).rejects.toMatchObject({
      code: 'functions/failed-precondition',
      details: {
        unmet: [
          'driverVerified',
          'vehicleAdded',
          'vehicleVerified',
          'seatsSet',
          'destinationDeclared',
          'originSet',
          'seatsOffered',
          'detourSet',
        ],
      },
    });
  });

  it('refuses a driver with no vehicle at all, and a suspended account', async () => {
    const noVehicle = await person('DRIVER', 'avl-novehicle');
    await driverRef(noVehicle.uid).update({ verificationStatus: 'VERIFIED' });
    await expect(
      call(noVehicle.client, 'setAvailability', { status: 'ONLINE' }),
    ).rejects.toMatchObject({ code: 'functions/failed-precondition' });

    const suspended = await eligibleDriver('avl-suspended');
    await admin().firestore.doc(`users/${suspended.uid}`).update({ status: 'SUSPENDED' });
    await expect(
      call(suspended.client, 'setAvailability', { status: 'ONLINE' }),
    ).rejects.toMatchObject({ code: 'functions/failed-precondition' });
    expect((await driverDoc(suspended.uid))?.availabilityStatus).toBe('OFFLINE');
  });

  it('always lets a driver go offline, even one who could not go online now', async () => {
    const driver = await eligibleDriver('avl-offline-anyway');
    await setAvailability(driver.client, 'ONLINE');
    await driverRef(driver.uid).update({ verificationStatus: 'REJECTED' });
    await admin().firestore.doc(`users/${driver.uid}`).update({ status: 'SUSPENDED' });

    expect(await setAvailability(driver.client, 'OFFLINE')).toBe('updated');
    expect((await driverDoc(driver.uid))?.availabilityStatus).toBe('OFFLINE');
  });

  it.each([{}, { status: 'BUSY' }, { status: 'online' }, { status: null }, 'ONLINE'])(
    'rejects the request %j',
    async (data) => {
      const driver = await eligibleDriver('avl-invalid');
      await expect(call(driver.client, 'setAvailability', data)).rejects.toMatchObject({
        code: 'functions/invalid-argument',
      });
      expect((await driverDoc(driver.uid))?.availabilityStatus).toBe('OFFLINE');
    },
  );

  it('refuses callers who are not verified drivers', async () => {
    await expect(
      call(createClient(), 'setAvailability', { status: 'ONLINE' }),
    ).rejects.toMatchObject({ code: 'functions/unauthenticated' });
    const callers = [
      await person('PASSENGER', 'avl-pass'),
      await person('DRIVER', 'avl-unverified', false),
      await staff('avl-staff'),
    ];
    for (const caller of callers) {
      await expect(
        call(caller.client, 'setAvailability', { status: 'ONLINE' }),
      ).rejects.toMatchObject({ code: 'functions/permission-denied' });
    }
  });

  it('only ever changes the caller own profile', async () => {
    const mine = await eligibleDriver('avl-mine');
    const theirs = await eligibleDriver('avl-theirs');
    await call(mine.client, 'setAvailability', {
      status: 'ONLINE',
      driverId: theirs.uid,
      uid: theirs.uid,
    });
    expect((await driverDoc(mine.uid))?.availabilityStatus).toBe('ONLINE');
    expect((await driverDoc(theirs.uid))?.availabilityStatus).toBe('OFFLINE');
  });

  it('cannot be bypassed by writing the availability directly', async () => {
    const driver = await eligibleDriver('avl-direct');
    await expect(
      updateDoc(doc(driver.client.db, `drivers/${driver.uid}`), { availabilityStatus: 'ONLINE' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    const pending = await person('DRIVER', 'avl-direct-pending');
    await expect(
      updateDoc(doc(pending.client.db, `drivers/${pending.uid}`), { availabilityStatus: 'ONLINE' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await driverDoc(pending.uid))?.availabilityStatus).toBe('OFFLINE');
  });

  it('follows availability live', async () => {
    const driver = await eligibleDriver('avl-live');
    const snapshots: DriverProfileSnapshot[] = [];
    const unsubscribe = subscribeToDriverProfile(
      driver.client,
      driver.uid,
      (snapshot) => snapshots.push(snapshot),
      (error) => {
        throw error;
      },
    );
    try {
      await expect
        .poll(() => snapshots.at(-1))
        .toMatchObject({ status: 'ready', driver: { availabilityStatus: 'OFFLINE' } });
      await setAvailability(driver.client, 'ONLINE');
      await expect
        .poll(() => snapshots.at(-1))
        .toMatchObject({ status: 'ready', driver: { availabilityStatus: 'ONLINE' } });
    } finally {
      unsubscribe();
    }
  });
});

describe('losing the right to be online takes the driver offline', () => {
  async function onlineDriver(prefix: string) {
    const driver = await eligibleDriver(prefix);
    await setAvailability(driver.client, 'ONLINE');
    return driver;
  }

  it.each([
    ['driver', 'reviewDriver'],
    ['vehicle', 'reviewVehicle'],
  ] as const)('when staff reject the %s', async (what, reviewFunction) => {
    const reviewer = await staff(`avl-reject-${what}`);
    const driver = await onlineDriver(`avl-reject-${what}-d`);

    await call(reviewer.client, reviewFunction, {
      driverId: driver.uid,
      decision: 'REJECTED',
      reason: 'Not good enough.',
    });

    expect((await driverDoc(driver.uid))?.availabilityStatus).toBe('OFFLINE');
    const entries = await offlineAudit(driver.uid);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data()).toMatchObject({
      actor: reviewer.uid,
      previousState: { availabilityStatus: 'ONLINE' },
      newState: { availabilityStatus: 'OFFLINE' },
      reason: `The ${what} is no longer verified`,
    });
    if (what === 'driver') {
      expect((await driverDoc(driver.uid))?.verificationStatus).toBe('REJECTED');
    } else {
      expect((await driverDoc(driver.uid))?.verificationStatus).toBe('VERIFIED');
      expect((await vehicleDoc(driver.uid))?.verificationStatus).toBe('REJECTED');
    }
  });

  it('when the driver changes the vehicle details', async () => {
    const driver = await onlineDriver('avl-edit');
    await saveVehicle(driver.client, {
      type: 'CAR',
      make: 'Toyota',
      model: 'Yaris',
      plateNumber: uniquePlate(),
    });

    expect((await driverDoc(driver.uid))?.availabilityStatus).toBe('OFFLINE');
    expect((await vehicleDoc(driver.uid))?.verificationStatus).toBe('PENDING');
    const entries = await offlineAudit(driver.uid);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data()).toMatchObject({
      actor: driver.uid,
      reason: 'Vehicle details changed',
    });
  });

  it('when the driver raises the seats', async () => {
    const driver = await onlineDriver('avl-raise');
    await setVehicleCapacity(driver.client, 5);

    expect((await driverDoc(driver.uid))?.availabilityStatus).toBe('OFFLINE');
    expect((await vehicleDoc(driver.uid))?.verificationStatus).toBe('PENDING');
    expect((await offlineAudit(driver.uid))[0]?.get('reason')).toBe('Vehicle seats raised');
  });

  it('but not when the driver lowers the seats, which needs no new review', async () => {
    const driver = await onlineDriver('avl-lower');
    await setVehicleCapacity(driver.client, 2);

    expect((await driverDoc(driver.uid))?.availabilityStatus).toBe('ONLINE');
    expect((await vehicleDoc(driver.uid))?.verificationStatus).toBe('VERIFIED');
    expect(await offlineAudit(driver.uid)).toHaveLength(0);
  });

  it('but not when staff verify, or when saving identical vehicle details', async () => {
    const reviewer = await staff('avl-keep');
    const driver = await onlineDriver('avl-keep-d');
    await call(reviewer.client, 'reviewDriver', { driverId: driver.uid, decision: 'VERIFIED' });
    await call(reviewer.client, 'reviewVehicle', { driverId: driver.uid, decision: 'VERIFIED' });
    const vehicle = await vehicleDoc(driver.uid);
    await saveVehicle(driver.client, {
      type: vehicle?.type,
      make: vehicle?.make,
      model: vehicle?.model,
      plateNumber: vehicle?.plateNumber,
    });

    expect((await driverDoc(driver.uid))?.availabilityStatus).toBe('ONLINE');
    expect(await offlineAudit(driver.uid)).toHaveLength(0);
  });

  it('and does not audit anything for a driver who was already offline', async () => {
    const reviewer = await staff('avl-already');
    const driver = await eligibleDriver('avl-already-d');
    await call(reviewer.client, 'reviewDriver', {
      driverId: driver.uid,
      decision: 'REJECTED',
      reason: 'No.',
    });
    await saveVehicle(driver.client, {
      type: 'CAR',
      make: 'Honda',
      model: 'Civic',
      plateNumber: uniquePlate(),
    });
    expect(await offlineAudit(driver.uid)).toHaveLength(0);
  });

  it('and then refuses to go online again until everything is verified again', async () => {
    const reviewer = await staff('avl-back');
    const driver = await onlineDriver('avl-back-d');
    await call(reviewer.client, 'reviewVehicle', {
      driverId: driver.uid,
      decision: 'REJECTED',
      reason: 'Photo unclear.',
    });
    await expect(
      call(driver.client, 'setAvailability', { status: 'ONLINE' }),
    ).rejects.toMatchObject({
      code: 'functions/failed-precondition',
      details: { unmet: ['vehicleVerified'] },
    });

    await call(reviewer.client, 'reviewVehicle', { driverId: driver.uid, decision: 'VERIFIED' });
    expect(await setAvailability(driver.client, 'ONLINE')).toBe('updated');
  });
});
