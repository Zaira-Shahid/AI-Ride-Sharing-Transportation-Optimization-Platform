import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { EXPORT_RECORD_CAP } from '../../functions/src/dataRights';
import { deleteDriverAccount, exportDriverData } from '../../functions/src/driverDataRights';
import {
  deleteMyAccount as deleteMyAccountClient,
  exportMyData as exportMyDataClient,
} from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail } from './support';

// Phase 14 (Privacy compliance): a driver's own data export and account deletion
// (functions/src/driverDataRights.ts), the second half of dataRights.int.test.ts (the passenger's). The
// functions are called directly, plus one run of each through the real callable and the client
// wrappers (which also proves the callables pick the driver's side by the signed role).
//
// Journeys and trips are seeded straight into Firestore in states nothing reacts to (COMPLETED or
// CANCELLED). The few in-flight fixtures used to prove a refusal are ended again before the test
// finishes, so the shared emulator's global batch runs never see a leftover open journey or request.

const HOME = { latitude: 51.5, longitude: -0.1, formattedAddress: '1 Home Street, London' };
const OFFICE = { latitude: 51.6, longitude: -0.2, formattedAddress: '2 Office Road, London' };
const PLATE = 'ZX99 YYY';

let counter = 0;

async function driver(opts: { online?: boolean } = {}) {
  counter += 1;
  const email = `driver-rights-${Date.now()}-${counter}@example.test`;
  const account = await admin().auth.createUser({ email, emailVerified: true });
  const uid = account.uid;
  const now = Timestamp.now();
  const plate = `${PLATE.slice(0, 5)}${counter}`.toUpperCase();
  await admin()
    .firestore.collection('users')
    .doc(uid)
    .set({
      role: 'DRIVER',
      name: `Driver Person ${counter}`,
      email,
      phone: '+441234567891',
      photoUrl: null,
      status: 'ACTIVE',
      statusReason: null,
      pushToken: null,
      createdAt: now,
      updatedAt: now,
    });
  await admin()
    .firestore.collection('drivers')
    .doc(uid)
    .set({
      userId: uid,
      verificationStatus: 'VERIFIED',
      verificationReason: null,
      availabilityStatus: opts.online ? 'ONLINE' : 'OFFLINE',
      rating: 4.8,
      totalTrips: 12,
      currentJourneyId: null,
      createdAt: now,
      updatedAt: now,
    });
  await admin()
    .firestore.collection('vehicles')
    .doc(uid)
    .set({
      driverId: uid,
      type: 'CAR',
      make: 'Toyota',
      model: 'Prius',
      plateNumber: plate,
      plateKey: plate.replace(/[\s-]/g, ''),
      seatCapacity: 3,
      availableSeats: 3,
      verificationStatus: 'VERIFIED',
      verificationReason: null,
      createdAt: now,
      updatedAt: now,
    });
  return {
    uid,
    email,
    plate,
    plateKey: plate.replace(/[\s-]/g, ''),
    caller: { uid, role: 'DRIVER', emailVerified: true },
  };
}

async function journey(driverId: string, status: string, fields: Record<string, unknown> = {}) {
  const ref = admin().firestore.collection('driverJourneys').doc();
  const now = Timestamp.now();
  await ref.set({
    driverId,
    vehicleId: driverId,
    status,
    origin: HOME,
    destination: OFFICE,
    currentLocation: { latitude: 51.55, longitude: -0.15 },
    departureTime: now,
    matchedTripRequestIds: [],
    createdAt: now,
    updatedAt: now,
    ...fields,
  });
  return ref.id;
}

async function trip(driverId: string, fields: Record<string, unknown> = {}) {
  counter += 1;
  const ref = admin().firestore.collection('tripRequests').doc();
  const now = Timestamp.now();
  await ref.set({
    passengerId: `passenger-of-${driverId}`,
    passengerName: 'Rider One',
    status: 'COMPLETED',
    origin: HOME,
    destination: OFFICE,
    matchedDriverId: driverId,
    driverName: 'Dana',
    vehicleType: 'CAR',
    vehicleMake: 'Toyota',
    vehicleModel: 'Prius',
    vehiclePlateNumber: PLATE,
    driverLocation: { latitude: 51.55, longitude: -0.15, accuracy: 5 },
    finalFareMinorUnits: 1250,
    platformFeeMinorUnits: 250,
    paymentStatus: 'CAPTURED',
    paymentIntentId: 'pi_secret',
    sharedRide: false,
    placesCleared: false,
    endedAt: now,
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
    ...fields,
  });
  return ref.id;
}

async function earning(driverId: string, tripId: string) {
  const ref = admin().firestore.collection('driverEarnings').doc();
  await ref.set({
    driverId,
    tripId,
    amountMinorUnits: 1000,
    currency: 'usd',
    createdAt: Timestamp.now(),
  });
  return ref.id;
}

async function plan(driverId: string) {
  const ref = admin().firestore.collection('journeyPlans').doc();
  await ref.set({
    journeyId: 'j',
    driverId,
    requestIds: ['r1'],
    stops: [{ kind: 'pickup', requestId: 'r1' }],
    createdAt: Timestamp.now(),
  });
  return ref.id;
}

async function notification(recipientId: string, message: string) {
  await admin()
    .firestore.collection('notifications')
    .add({ recipientId, type: 'DRIVER_DELAYED', message, createdAt: Timestamp.now() });
}

const exists = async (path: string) => (await admin().firestore.doc(path).get()).exists;
const data = async (path: string) => (await admin().firestore.doc(path).get()).data() ?? {};
const authExists = async (uid: string) =>
  admin()
    .auth.getUser(uid)
    .then(() => true)
    .catch(() => false);
const auditsFor = async (uid: string, action: string) =>
  (
    await admin()
      .firestore.collection('auditLogs')
      .where('entity', '==', `users/${uid}`)
      .where('action', '==', action)
      .get()
  ).docs.map((doc) => doc.data());

describe('exportDriverData', () => {
  const run = (d: { caller: { uid: string; role: string; emailVerified: boolean } }) =>
    exportDriverData({ firestore: admin().firestore }, d.caller);

  it('refuses anyone but a verified driver', async () => {
    const deps = { firestore: admin().firestore };
    await expect(
      exportDriverData(deps, { uid: 'x', role: 'PASSENGER', emailVerified: true }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      exportDriverData(deps, { uid: 'x', role: 'DRIVER', emailVerified: false }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('returns the driver own profile, vehicle, journeys, earnings, rides and notifications', async () => {
    const d = await driver();
    const tripId = await trip(d.uid);
    const journeyId = await journey(d.uid, 'COMPLETED', { matchedTripRequestIds: [tripId] });
    await earning(d.uid, tripId);
    await notification(d.uid, 'You are running late');

    const out = await run(d);

    expect(out.profile).toMatchObject({ email: d.email, phone: '+441234567891', status: 'ACTIVE' });
    expect(out.driver).toMatchObject({
      verificationStatus: 'VERIFIED',
      availabilityStatus: 'OFFLINE',
      rating: 4.8,
      totalTrips: 12,
    });
    expect(out.vehicle).toMatchObject({
      make: 'Toyota',
      model: 'Prius',
      plateNumber: d.plate,
      seatCapacity: 3,
    });
    expect(out.journeys).toEqual([
      expect.objectContaining({
        journeyId,
        status: 'COMPLETED',
        passengersMatched: 1,
        origin: expect.objectContaining({ formattedAddress: HOME.formattedAddress }),
      }),
    ]);
    expect(out.earnings).toEqual([
      expect.objectContaining({ tripId, amountMinorUnits: 1000, currency: 'usd' }),
    ]);
    expect(out.trips).toEqual([
      expect.objectContaining({ tripId, status: 'COMPLETED', finalFareMinorUnits: 1250 }),
    ]);
    expect(out.notifications).toEqual([
      expect.objectContaining({ message: 'You are running late' }),
    ]);
    expect(out.truncated).toBe(false);
  });

  it('never includes a passenger name, place or payment detail, or internal bookkeeping', async () => {
    const d = await driver();
    await trip(d.uid);
    const text = JSON.stringify(await run(d));
    for (const secret of [
      'Rider One',
      'passenger-of-',
      HOME.formattedAddress.slice(0, 8),
      OFFICE.formattedAddress,
      'pi_secret',
      'platformFee',
      'CAPTURED',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('does not include another driver records', async () => {
    const mine = await driver();
    const other = await driver();
    await trip(other.uid);
    await journey(other.uid, 'COMPLETED');
    await earning(other.uid, 't');
    await notification(other.uid, 'someone else');

    const out = await run(mine);
    expect(out.trips).toHaveLength(0);
    expect(out.journeys).toHaveLength(0);
    expect(out.earnings).toHaveLength(0);
    expect(out.notifications).toHaveLength(0);
  });

  it('reports a cleared place as null', async () => {
    const d = await driver();
    await journey(d.uid, 'COMPLETED', { origin: null, destination: null });
    const out = await run(d);
    expect(out.journeys[0]).toMatchObject({ origin: null, destination: null });
  });

  it('caps a record kind and says it was cut off', async () => {
    const d = await driver();
    const writer = admin().firestore.bulkWriter();
    for (let i = 0; i < EXPORT_RECORD_CAP + 1; i += 1) {
      void writer.create(admin().firestore.collection('driverEarnings').doc(), {
        driverId: d.uid,
        tripId: `t${i}`,
        amountMinorUnits: 1,
        currency: 'usd',
        createdAt: Timestamp.now(),
      });
    }
    await writer.close();

    const out = await run(d);
    expect(out.earnings).toHaveLength(EXPORT_RECORD_CAP);
    expect(out.truncated).toBe(true);
  });

  it('audits that an export happened, holding none of the data', async () => {
    const d = await driver();
    await run(d);
    const entries = await auditsFor(d.uid, 'ACCOUNT_DATA_EXPORTED');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: d.uid });
    expect(JSON.stringify(entries[0])).not.toContain(d.email);
  });
});

describe('deleteDriverAccount', () => {
  const deleteAs = (
    d: { caller: { uid: string; role: string; emailVerified: boolean } },
    input: unknown = { confirm: 'DELETE' },
  ) => deleteDriverAccount({ firestore: admin().firestore, auth: admin().auth }, d.caller, input);

  /** Everything is still there: the account was not touched. */
  async function expectUntouched(d: Awaited<ReturnType<typeof driver>>) {
    expect(await exists(`users/${d.uid}`)).toBe(true);
    expect(await exists(`drivers/${d.uid}`)).toBe(true);
    expect(await exists(`vehicles/${d.uid}`)).toBe(true);
    expect(await authExists(d.uid)).toBe(true);
  }

  it('refuses anyone but a verified driver', async () => {
    await expect(
      deleteDriverAccount(
        { firestore: admin().firestore, auth: admin().auth },
        { uid: 'x', role: 'PASSENGER', emailVerified: true },
        { confirm: 'DELETE' },
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('needs the exact confirmation and changes nothing without it', async () => {
    // null, not undefined: undefined would fall back to deleteAs's own valid default. A fresh driver
    // per input, since every attempt (valid or not) counts against the rate limit.
    for (const input of [null, {}, { confirm: 'delete' }, { confirm: true }]) {
      const d = await driver();
      await expect(deleteAs(d, input)).rejects.toMatchObject({ code: 'invalid-argument' });
      await expectUntouched(d);
    }
  });

  it('rate limits repeated attempts, even a correctly confirmed one, changing nothing', async () => {
    const d = await driver();
    for (let i = 0; i < 3; i += 1) {
      await expect(deleteAs(d, null)).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    await expect(deleteAs(d)).rejects.toMatchObject({ code: 'resource-exhausted' });
    await expectUntouched(d);
  });

  it('refuses while the driver is online, changing nothing', async () => {
    const d = await driver({ online: true });
    await expect(deleteAs(d)).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'Go offline before deleting your account.',
    });
    await expectUntouched(d);
  });

  it.each(['AVAILABLE', 'MATCHING', 'ACTIVE'])(
    'refuses while a journey is %s, changing nothing',
    async (status) => {
      const d = await driver();
      const journeyId = await journey(d.uid, status);
      try {
        await expect(deleteAs(d)).rejects.toMatchObject({ code: 'failed-precondition' });
        await expectUntouched(d);
        expect((await data(`driverJourneys/${journeyId}`)).driverId).toBe(d.uid);
      } finally {
        // No open journey left behind for the shared emulator's global batch runs.
        await admin().firestore.doc(`driverJourneys/${journeyId}`).update({ status: 'COMPLETED' });
      }
    },
  );

  it.each([
    ['a ride in progress', { status: 'IN_TRANSIT', paymentStatus: null, endedAt: null }],
    ['a ride about to start', { status: 'DRIVER_ARRIVING', paymentStatus: null, endedAt: null }],
    ['an outstanding payment hold', { status: 'COMPLETED', paymentStatus: 'AUTHORIZED' }],
    [
      'an unreviewed dispute',
      { status: 'COMPLETED', paymentStatus: 'DISPUTED', disputeReviewed: false },
    ],
  ])('refuses while there is %s on a ride they drove, changing nothing', async (_name, fields) => {
    const d = await driver();
    const tripId = await trip(d.uid, fields);
    try {
      await expect(deleteAs(d)).rejects.toMatchObject({ code: 'failed-precondition' });
      await expectUntouched(d);
      expect((await data(`tripRequests/${tripId}`)).matchedDriverId).toBe(d.uid);
    } finally {
      await admin()
        .firestore.doc(`tripRequests/${tripId}`)
        .update({ status: 'CANCELLED', paymentStatus: null });
    }
  });

  it('goes ahead once a dispute has been reviewed', async () => {
    const d = await driver();
    await trip(d.uid, { paymentStatus: 'DISPUTED', disputeReviewed: true });
    await expect(deleteAs(d)).resolves.toEqual({ status: 'deleted' });
  });

  it('goes ahead for a driver who has never driven anyone', async () => {
    const d = await driver();
    await expect(deleteAs(d)).resolves.toEqual({ status: 'deleted' });
    expect(await authExists(d.uid)).toBe(false);
  });

  it('deletes the account, the profile, the vehicle and the notifications, and frees the plate', async () => {
    const d = await driver();
    await notification(d.uid, 'one');
    await notification(d.uid, 'two');

    await expect(deleteAs(d)).resolves.toEqual({ status: 'deleted' });

    expect(await exists(`users/${d.uid}`)).toBe(false);
    expect(await exists(`drivers/${d.uid}`)).toBe(false);
    expect(await exists(`vehicles/${d.uid}`)).toBe(false);
    expect(await authExists(d.uid)).toBe(false);
    const left = await admin()
      .firestore.collection('notifications')
      .where('recipientId', '==', d.uid)
      .get();
    expect(left.size).toBe(0);
    // Uniqueness of a plate is a query on the vehicles themselves, so another driver may use it now.
    const plate = await admin()
      .firestore.collection('vehicles')
      .where('plateKey', '==', d.plateKey)
      .get();
    expect(plate.size).toBe(0);
  });

  it("takes the driver out of the passenger's trip, leaving the trip and the passenger intact", async () => {
    const d = await driver();
    const tripId = await trip(d.uid);

    await deleteAs(d);

    expect(await data(`tripRequests/${tripId}`)).toMatchObject({
      // The driver is gone from it.
      matchedDriverId: null,
      driverName: null,
      vehicleType: null,
      vehicleMake: null,
      vehicleModel: null,
      vehiclePlateNumber: null,
      driverLocation: null,
      // Kept: the trip, its money, and everything of the passenger's.
      status: 'COMPLETED',
      finalFareMinorUnits: 1250,
      platformFeeMinorUnits: 250,
      paymentStatus: 'CAPTURED',
      paymentIntentId: 'pi_secret',
      passengerId: `passenger-of-${d.uid}`,
      passengerName: 'Rider One',
      origin: { formattedAddress: HOME.formattedAddress },
      destination: { formattedAddress: OFFICE.formattedAddress },
    });
  });

  it('keeps the earnings ledger with the link to the driver removed', async () => {
    const d = await driver();
    const tripId = await trip(d.uid);
    const earningId = await earning(d.uid, tripId);

    await deleteAs(d);

    expect(await data(`driverEarnings/${earningId}`)).toMatchObject({
      driverId: null,
      tripId,
      amountMinorUnits: 1000,
      currency: 'usd',
    });
  });

  it('clears the places and the link from journeys and route plans, keeping their record', async () => {
    const d = await driver();
    const journeyId = await journey(d.uid, 'COMPLETED', { matchedTripRequestIds: ['a', 'b'] });
    const planId = await plan(d.uid);

    await deleteAs(d);

    expect(await data(`driverJourneys/${journeyId}`)).toMatchObject({
      driverId: null,
      vehicleId: null,
      origin: null,
      destination: null,
      currentLocation: null,
      placesCleared: true,
      status: 'COMPLETED',
      matchedTripRequestIds: ['a', 'b'],
    });
    expect(await data(`journeyPlans/${planId}`)).toMatchObject({
      driverId: null,
      requestIds: ['r1'],
    });
  });

  it('leaves another driver records alone', async () => {
    const mine = await driver();
    const other = await driver();
    const otherTrip = await trip(other.uid);
    const otherJourney = await journey(other.uid, 'COMPLETED');
    const otherEarning = await earning(other.uid, otherTrip);
    await notification(other.uid, 'keep me');

    await deleteAs(mine);

    expect((await data(`tripRequests/${otherTrip}`)).matchedDriverId).toBe(other.uid);
    expect((await data(`tripRequests/${otherTrip}`)).driverName).toBe('Dana');
    expect((await data(`driverJourneys/${otherJourney}`)).driverId).toBe(other.uid);
    expect((await data(`driverEarnings/${otherEarning}`)).driverId).toBe(other.uid);
    await expectUntouched(other);
    const kept = await admin()
      .firestore.collection('notifications')
      .where('recipientId', '==', other.uid)
      .get();
    expect(kept.size).toBe(1);
  });

  it('audits the deletion with the uid only, never a name, email or plate', async () => {
    const d = await driver();
    await deleteAs(d);
    const entries = await auditsFor(d.uid, 'ACCOUNT_DELETED');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: d.uid });
    const text = JSON.stringify(entries[0]);
    expect(text).not.toContain(d.email);
    expect(text).not.toContain('Driver Person');
    expect(text).not.toContain(d.plate);
  });

  it('finishes a half-done deletion when called again', async () => {
    const d = await driver();
    const tripId = await trip(d.uid);
    // The earlier attempt got as far as removing the profiles and the sign-in account.
    await admin().firestore.doc(`vehicles/${d.uid}`).delete();
    await admin().firestore.doc(`drivers/${d.uid}`).delete();
    await admin().firestore.doc(`users/${d.uid}`).delete();
    await admin().auth.deleteUser(d.uid);

    await expect(deleteAs(d)).resolves.toEqual({ status: 'deleted' });
    expect((await data(`tripRequests/${tripId}`)).matchedDriverId).toBeNull();
  });
});

describe('through the real callables and the client wrappers', () => {
  async function signedInDriver(prefix: string) {
    const client = createClient();
    const { user, uid, email } = await signUp(client, prefix);
    await admin().auth.setCustomUserClaims(uid, { role: 'DRIVER' });
    await verifyEmail(user, email);
    const now = Timestamp.now();
    await admin().firestore.collection('users').doc(uid).set({
      role: 'DRIVER',
      name: 'Wrapper Driver',
      email,
      phone: null,
      photoUrl: null,
      status: 'ACTIVE',
      statusReason: null,
      pushToken: null,
      createdAt: now,
      updatedAt: now,
    });
    await admin().firestore.collection('drivers').doc(uid).set({
      userId: uid,
      verificationStatus: 'VERIFIED',
      verificationReason: null,
      availabilityStatus: 'OFFLINE',
      rating: null,
      totalTrips: 0,
      currentJourneyId: null,
      createdAt: now,
      updatedAt: now,
    });
    return { client, uid, email };
  }

  it('exports the driver side and then deletes the account', async () => {
    const d = await signedInDriver('driver-rights-wrapper');
    const tripId = await trip(d.uid);

    const out = await exportMyDataClient(d.client);
    // A driver gets the driver export, not the passenger one.
    expect(out).toHaveProperty('vehicle');
    expect(out).toHaveProperty('earnings');
    expect(out).not.toHaveProperty('receipts');
    expect(out.profile.email).toBe(d.email);
    expect(out.trips).toEqual([expect.objectContaining({ tripId })]);

    expect(await deleteMyAccountClient(d.client)).toBe('deleted');
    expect(await exists(`users/${d.uid}`)).toBe(false);
    expect(await exists(`drivers/${d.uid}`)).toBe(false);
    expect(await authExists(d.uid)).toBe(false);
    expect((await data(`tripRequests/${tripId}`)).matchedDriverId).toBeNull();
  });

  it('is refused for a driver who is online', async () => {
    const d = await signedInDriver('driver-rights-online');
    await admin().firestore.doc(`drivers/${d.uid}`).update({ availabilityStatus: 'ONLINE' });
    await expect(deleteMyAccountClient(d.client)).rejects.toMatchObject({
      code: 'functions/failed-precondition',
    });
    expect(await exists(`users/${d.uid}`)).toBe(true);
  });
});
