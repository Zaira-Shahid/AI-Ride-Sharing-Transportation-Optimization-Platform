import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  describeAuthError,
  saveVehicle,
  subscribeToVehicle,
  type VehicleSnapshot,
} from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

const CAR = { type: 'CAR', make: 'Toyota', model: 'Corolla', plateNumber: 'ABC-123' } as const;
const form = (overrides: Partial<Record<'type' | 'make' | 'model' | 'plateNumber', string>> = {}) =>
  ({ ...CAR, ...overrides }) as Parameters<typeof saveVehicle>[1];

function callSaveVehicle(client: Client, data: unknown) {
  return httpsCallable(client.functions, 'saveVehicle')(data);
}

async function person(role: 'DRIVER' | 'PASSENGER', prefix: string, verified = true) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
  if (verified) await verifyEmail(user, email);
  else await user.getIdToken(true);
  return { client, uid };
}

const driver = (prefix: string) => person('DRIVER', prefix);
const stored = async (uid: string) => (await admin().firestore.doc(`vehicles/${uid}`).get()).data();
const audit = async (uid: string) =>
  (await admin().firestore.collection('auditLogs').where('entity', '==', `vehicles/${uid}`).get())
    .docs;

// Plates are unique across vehicles, so every test starts with no vehicles.
beforeEach(async () => {
  const { firestore } = admin();
  await firestore.recursiveDelete(firestore.collection('vehicles'));
});

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject.');
}

describe('saveVehicle: creating (functions + firestore emulators)', () => {
  it('creates vehicles/{uid} with a tidy plate and no seats yet', async () => {
    const { client, uid } = await driver('veh-new');
    const result = await callSaveVehicle(client, {
      type: 'VAN',
      make: '  Ford ',
      model: 'Transit',
      plateNumber: ' ab 12  cd ',
    });
    expect(result.data).toEqual({ status: 'created' });

    expect(await stored(uid)).toMatchObject({
      driverId: uid,
      type: 'VAN',
      make: 'Ford',
      model: 'Transit',
      plateNumber: 'AB 12 CD',
      plateKey: 'AB12CD',
      seatCapacity: null,
      availableSeats: null,
      verificationStatus: 'PENDING',
    });
    expect((await stored(uid))?.createdAt).toBeDefined();

    const entries = await audit(uid);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data()).toMatchObject({
      actor: uid,
      action: 'VEHICLE_CREATED',
      previousState: null,
      newState: { type: 'VAN', plateKey: 'AB12CD', verificationStatus: 'PENDING' },
    });
  });

  it('ignores anything the caller tries to set beyond the four details', async () => {
    const { client, uid } = await driver('veh-extra');
    await callSaveVehicle(client, {
      ...CAR,
      seatCapacity: 99,
      availableSeats: 99,
      verificationStatus: 'VERIFIED',
      driverId: 'someone-else',
    });
    expect(await stored(uid)).toMatchObject({
      driverId: uid,
      seatCapacity: null,
      availableSeats: null,
      verificationStatus: 'PENDING',
    });
  });

  it('works through the app helper and reports the outcome', async () => {
    const { client } = await driver('veh-app');
    expect(await saveVehicle(client, form())).toBe('created');
    expect(await saveVehicle(client, form())).toBe('unchanged');
    expect(await saveVehicle(client, form({ model: 'Yaris' }))).toBe('updated');
  });

  it('refuses callers who are not verified drivers', async () => {
    const unauthenticated = createClient();
    await expect(callSaveVehicle(unauthenticated, CAR)).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });

    const passenger = await person('PASSENGER', 'veh-pass');
    await expect(callSaveVehicle(passenger.client, CAR)).rejects.toMatchObject({
      code: 'functions/permission-denied',
    });
    expect(await stored(passenger.uid)).toBeUndefined();

    const unverified = await person('DRIVER', 'veh-unverified', false);
    await expect(callSaveVehicle(unverified.client, CAR)).rejects.toMatchObject({
      code: 'functions/permission-denied',
    });
    expect(await stored(unverified.uid)).toBeUndefined();
  });

  it('refuses a suspended driver and a driver with no driver profile', async () => {
    const suspended = await driver('veh-suspended');
    await admin().firestore.doc(`users/${suspended.uid}`).update({ status: 'SUSPENDED' });
    await expect(callSaveVehicle(suspended.client, CAR)).rejects.toMatchObject({
      code: 'functions/failed-precondition',
    });
    expect(await stored(suspended.uid)).toBeUndefined();

    const gone = await driver('veh-nodriver');
    await admin().firestore.doc(`drivers/${gone.uid}`).delete();
    const error = await failureOf(saveVehicle(gone.client, form()));
    expect(describeAuthError(error).kind).toBe('permission');
    expect(await stored(gone.uid)).toBeUndefined();
  });

  it.each([
    ['an unknown type', { type: 'BUS' }],
    ['a blank make', { make: '   ' }],
    ['a blank model', { model: '' }],
    ['an oversized make', { make: 'x'.repeat(51) }],
    ['a single-character plate', { plateNumber: 'A' }],
    ['a plate with symbols', { plateNumber: 'AB#123' }],
    ['a plate that is only separators', { plateNumber: '- -' }],
    ['a too-long plate', { plateNumber: 'ABCDEFGHIJKLM' }],
    ['a missing plate', { plateNumber: undefined }],
  ])('rejects %s', async (_label, override) => {
    const { client, uid } = await driver('veh-invalid');
    await expect(callSaveVehicle(client, { ...CAR, ...override })).rejects.toMatchObject({
      code: 'functions/invalid-argument',
    });
    expect(await stored(uid)).toBeUndefined();
  });
});

describe('saveVehicle: editing', () => {
  it('updates the details, sends a verified vehicle back to PENDING, and audits the change', async () => {
    const { client, uid } = await driver('veh-edit');
    await saveVehicle(client, form());
    await admin().firestore.doc(`vehicles/${uid}`).update({ verificationStatus: 'VERIFIED' });

    expect(await saveVehicle(client, form({ model: 'Yaris', plateNumber: 'XYZ 999' }))).toBe(
      'updated',
    );
    expect(await stored(uid)).toMatchObject({
      model: 'Yaris',
      plateNumber: 'XYZ 999',
      plateKey: 'XYZ999',
      verificationStatus: 'PENDING',
    });

    const entries = await audit(uid);
    expect(entries).toHaveLength(2);
    const update = entries.find((entry) => entry.get('action') === 'VEHICLE_UPDATED');
    expect(update?.data()).toMatchObject({
      actor: uid,
      previousState: { model: 'Corolla', plateKey: 'ABC123', verificationStatus: 'VERIFIED' },
      newState: { model: 'Yaris', plateKey: 'XYZ999', verificationStatus: 'PENDING' },
    });
  });

  it('leaves a verified vehicle and its audit trail alone when nothing changed', async () => {
    const { client, uid } = await driver('veh-same');
    await saveVehicle(client, form());
    await admin().firestore.doc(`vehicles/${uid}`).update({ verificationStatus: 'VERIFIED' });

    // The plate text changed ("ABC-123" to "ABC 123"), so this is an edit and needs a new review.
    expect(await saveVehicle(client, form({ plateNumber: 'abc 123' }))).toBe('updated');
    await admin().firestore.doc(`vehicles/${uid}`).update({ verificationStatus: 'VERIFIED' });
    expect(await saveVehicle(client, form({ plateNumber: 'abc 123' }))).toBe('unchanged');

    expect((await stored(uid))?.verificationStatus).toBe('VERIFIED');
    expect(await audit(uid)).toHaveLength(2);
  });

  it('keeps the seat fields that later modules set', async () => {
    const { client, uid } = await driver('veh-seats');
    await saveVehicle(client, form());
    await admin().firestore.doc(`vehicles/${uid}`).update({ seatCapacity: 4, availableSeats: 3 });
    await saveVehicle(client, form({ make: 'Honda' }));
    expect(await stored(uid)).toMatchObject({ make: 'Honda', seatCapacity: 4, availableSeats: 3 });
  });
});

describe('saveVehicle: plate numbers are unique', () => {
  it('refuses a plate another driver already has, however it is written', async () => {
    const first = await driver('veh-first');
    const second = await driver('veh-second');
    await saveVehicle(first.client, form({ plateNumber: 'UNQ-1234' }));

    for (const spelling of ['UNQ-1234', 'unq 1234', 'UNQ1234', ' u-n-q1 234 ']) {
      const error = await failureOf(saveVehicle(second.client, form({ plateNumber: spelling })));
      expect(describeAuthError(error).kind).toBe('plate-in-use');
    }
    expect(await stored(second.uid)).toBeUndefined();
  });

  it('refuses changing to another driver plate and keeps the old details', async () => {
    const first = await driver('veh-own');
    const second = await driver('veh-other');
    await saveVehicle(first.client, form({ plateNumber: 'OWN-1111' }));
    await saveVehicle(second.client, form({ plateNumber: 'OTH-2222' }));

    const error = await failureOf(saveVehicle(second.client, form({ plateNumber: 'OWN-1111' })));
    expect(describeAuthError(error).kind).toBe('plate-in-use');
    expect(await stored(second.uid)).toMatchObject({ plateKey: 'OTH2222' });
  });

  it('frees a plate once its owner changes it', async () => {
    const first = await driver('veh-free-a');
    const second = await driver('veh-free-b');
    await saveVehicle(first.client, form({ plateNumber: 'OLD-0001' }));
    await saveVehicle(first.client, form({ plateNumber: 'NEW-0001' }));
    expect(await saveVehicle(second.client, form({ plateNumber: 'OLD-0001' }))).toBe('created');
  });

  it('lets exactly one of two simultaneous requests win the same plate', async () => {
    const a = await driver('veh-race-a');
    const b = await driver('veh-race-b');
    const results = await Promise.allSettled([
      saveVehicle(a.client, form({ plateNumber: 'RACE-777' })),
      saveVehicle(b.client, form({ plateNumber: 'race 777' })),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const snapshot = await admin()
      .firestore.collection('vehicles')
      .where('plateKey', '==', 'RACE777')
      .get();
    expect(snapshot.size).toBe(1);
  });
});

describe('reading the vehicle as the driver (real auth tokens)', () => {
  it('follows the vehicle live', async () => {
    const { client, uid } = await driver('veh-live');
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
      await expect.poll(() => snapshots.at(-1)).toEqual({ status: 'missing' });

      await saveVehicle(client, form());
      await expect
        .poll(() => snapshots.at(-1))
        .toEqual({
          status: 'ready',
          vehicle: {
            type: 'CAR',
            make: 'Toyota',
            model: 'Corolla',
            plateNumber: 'ABC-123',
            seatCapacity: null,
            verificationStatus: 'PENDING',
          },
        });

      await admin().firestore.doc(`vehicles/${uid}`).update({ verificationStatus: 'VERIFIED' });
      await expect
        .poll(() => snapshots.at(-1))
        .toMatchObject({ vehicle: { verificationStatus: 'VERIFIED' } });
    } finally {
      unsubscribe();
    }
  });

  it('keeps vehicles private and refuses every direct client write', async () => {
    const first = await driver('veh-priv-a');
    const second = await driver('veh-priv-b');
    const passenger = await person('PASSENGER', 'veh-priv-p');
    await saveVehicle(first.client, form());

    expect((await getDoc(doc(first.client.db, `vehicles/${first.uid}`))).get('make')).toBe(
      'Toyota',
    );
    await expect(getDoc(doc(second.client.db, `vehicles/${first.uid}`))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(getDoc(doc(passenger.client.db, `vehicles/${first.uid}`))).rejects.toMatchObject({
      code: 'permission-denied',
    });

    const own = doc(first.client.db, `vehicles/${first.uid}`);
    await expect(updateDoc(own, { verificationStatus: 'VERIFIED' })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(updateDoc(own, { seatCapacity: 50 })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(setDoc(own, { make: 'Hacked' })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(
      setDoc(doc(second.client.db, `vehicles/${second.uid}`), CAR),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await stored(first.uid))?.verificationStatus).toBe('PENDING');
  });
});
