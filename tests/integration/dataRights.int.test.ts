import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import {
  DELETED_PASSENGER_NAME,
  deleteMyAccount,
  EXPORT_RECORD_CAP,
  exportMyData,
} from '../../functions/src/dataRights';
import type { StripeProvider } from '../../functions/src/stripeProvider';
import {
  deleteMyAccount as deleteMyAccountClient,
  exportMyData as exportMyDataClient,
} from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail } from './support';

// Phase 14 (Privacy compliance): a passenger's own data export and account deletion
// (functions/src/dataRights.ts). The server functions are called directly with a fake Stripe, plus one
// run of each through the real callable and the client wrapper. Trip requests are seeded straight into
// Firestore in states the real match triggers ignore (COMPLETED/CANCELLED), so no trigger races a
// fixture; the few in-flight fixtures are cancelled again before the test ends so the shared
// emulator's global batch runs never see a leftover SEARCHING request.

const HOME = { latitude: 51.5, longitude: -0.1, formattedAddress: '1 Home Street, London' };
const OFFICE = { latitude: 51.6, longitude: -0.2, formattedAddress: '2 Office Road, London' };

let counter = 0;

function fakeStripe(overrides: Partial<StripeProvider> = {}) {
  const deleted: string[] = [];
  const provider: StripeProvider = {
    ping: async () => true,
    createCustomer: async () => 'cus_fake',
    deleteCustomer: async ({ stripeCustomerId }) => {
      deleted.push(stripeCustomerId);
      return { status: 'deleted' };
    },
    authorizePayment: async () => ({ status: 'authorized', paymentIntentId: 'pi_fake' }),
    capturePayment: async () => ({ status: 'captured' }),
    voidPayment: async () => ({ status: 'voided' }),
    refundPayment: async () => ({ status: 'refunded' }),
    verifyWebhookEvent: () => ({ status: 'invalid' }),
    ...overrides,
  };
  return { provider, deleted };
}

async function passenger(fields: Record<string, unknown> = {}) {
  counter += 1;
  const email = `rights-${Date.now()}-${counter}@example.test`;
  const account = await admin().auth.createUser({ email, emailVerified: true });
  await admin()
    .firestore.collection('users')
    .doc(account.uid)
    .set({
      role: 'PASSENGER',
      name: `Rights Person ${counter}`,
      email,
      phone: '+441234567890',
      photoUrl: null,
      status: 'ACTIVE',
      statusReason: null,
      pushToken: null,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...fields,
    });
  return {
    uid: account.uid,
    email,
    caller: { uid: account.uid, role: 'PASSENGER', emailVerified: true },
  };
}

async function trip(passengerId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const ref = admin().firestore.collection('tripRequests').doc();
  const now = Timestamp.now();
  await ref.set({
    passengerId,
    passengerName: 'Rights',
    status: 'COMPLETED',
    origin: HOME,
    destination: OFFICE,
    driverLocation: { latitude: 51.55, longitude: -0.15, accuracy: 5 },
    driverName: 'Dana',
    vehiclePlateNumber: 'PLATE-1',
    platformFeeMinorUnits: 250,
    finalFareMinorUnits: 1250,
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

async function receipt(passengerId: string, tripId: string) {
  await admin().firestore.collection('receipts').add({
    passengerId,
    tripId,
    currency: 'usd',
    baseFareMinorUnits: 250,
    distanceTimeComponentMinorUnits: 1000,
    sharedRideDiscountMinorUnits: 0,
    totalMinorUnits: 1250,
    createdAt: Timestamp.now(),
  });
}

async function notification(recipientId: string, message: string) {
  await admin()
    .firestore.collection('notifications')
    .add({ recipientId, type: 'DRIVER_DELAYED', message, createdAt: Timestamp.now() });
}

const userExists = async (uid: string) =>
  (await admin().firestore.collection('users').doc(uid).get()).exists;
const authExists = async (uid: string) =>
  admin()
    .auth.getUser(uid)
    .then(() => true)
    .catch(() => false);
const tripData = async (id: string) =>
  (await admin().firestore.collection('tripRequests').doc(id).get()).data() ?? {};
const auditsFor = async (uid: string, action: string) =>
  (
    await admin()
      .firestore.collection('auditLogs')
      .where('entity', '==', `users/${uid}`)
      .where('action', '==', action)
      .get()
  ).docs.map((doc) => doc.data());

describe('exportMyData', () => {
  it('refuses anyone but a verified passenger', async () => {
    const deps = { firestore: admin().firestore };
    await expect(
      exportMyData(deps, { uid: 'x', role: 'DRIVER', emailVerified: true }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      exportMyData(deps, { uid: 'x', role: 'PASSENGER', emailVerified: false }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('returns the passenger own profile, trips, receipts and notifications', async () => {
    const p = await passenger({ paymentMethodId: 'pm_secret', stripeCustomerId: 'cus_secret' });
    const tripId = await trip(p.uid);
    await receipt(p.uid, tripId);
    await notification(p.uid, 'Your driver is late');

    const data = await exportMyData({ firestore: admin().firestore }, p.caller);

    expect(data.profile).toMatchObject({
      email: p.email,
      phone: '+441234567890',
      status: 'ACTIVE',
      hasSavedPaymentMethod: true,
    });
    expect(data.trips).toHaveLength(1);
    expect(data.trips[0]).toMatchObject({
      tripId,
      status: 'COMPLETED',
      origin: { formattedAddress: HOME.formattedAddress },
      destination: { formattedAddress: OFFICE.formattedAddress },
      finalFareMinorUnits: 1250,
    });
    expect(data.receipts).toEqual([expect.objectContaining({ tripId, totalMinorUnits: 1250 })]);
    expect(data.notifications).toEqual([
      expect.objectContaining({ message: 'Your driver is late' }),
    ]);
    expect(data.truncated).toBe(false);
  });

  it('never includes another person data or internal bookkeeping', async () => {
    const p = await passenger({ paymentMethodId: 'pm_secret', stripeCustomerId: 'cus_secret' });
    await trip(p.uid);

    const text = JSON.stringify(await exportMyData({ firestore: admin().firestore }, p.caller));
    for (const secret of [
      'Dana',
      'PLATE-1',
      'pi_secret',
      'pm_secret',
      'cus_secret',
      'platformFee',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('does not include another passenger records', async () => {
    const mine = await passenger();
    const other = await passenger();
    await trip(other.uid);
    await notification(other.uid, 'someone else');

    const data = await exportMyData({ firestore: admin().firestore }, mine.caller);
    expect(data.trips).toHaveLength(0);
    expect(data.notifications).toHaveLength(0);
  });

  it('reports a cleared place as null', async () => {
    const p = await passenger();
    await trip(p.uid, { origin: null, destination: null, placesCleared: true });
    const data = await exportMyData({ firestore: admin().firestore }, p.caller);
    expect(data.trips[0]).toMatchObject({ origin: null, destination: null });
  });

  it('caps a record kind and says it was cut off', async () => {
    const p = await passenger();
    const writer = admin().firestore.bulkWriter();
    for (let i = 0; i < EXPORT_RECORD_CAP + 1; i += 1) {
      void writer.create(admin().firestore.collection('notifications').doc(), {
        recipientId: p.uid,
        type: 'DRIVER_DELAYED',
        message: `n${i}`,
        createdAt: Timestamp.now(),
      });
    }
    await writer.close();

    const data = await exportMyData({ firestore: admin().firestore }, p.caller);
    expect(data.notifications).toHaveLength(EXPORT_RECORD_CAP);
    expect(data.truncated).toBe(true);
  });

  it('audits that an export happened, holding none of the data', async () => {
    const p = await passenger();
    await exportMyData({ firestore: admin().firestore }, p.caller);
    const entries = await auditsFor(p.uid, 'ACCOUNT_DATA_EXPORTED');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: p.uid });
    expect(JSON.stringify(entries[0])).not.toContain(p.email);
  });
});

describe('deleteMyAccount', () => {
  const deleteWith = (
    p: { caller: { uid: string; role: string; emailVerified: boolean } },
    stripe: StripeProvider | undefined,
    input: unknown = { confirm: 'DELETE' },
  ) =>
    deleteMyAccount({ firestore: admin().firestore, auth: admin().auth, stripe }, p.caller, input);

  it('refuses anyone but a verified passenger', async () => {
    await expect(
      deleteMyAccount(
        { firestore: admin().firestore, auth: admin().auth },
        { uid: 'x', role: 'DRIVER', emailVerified: true },
        { confirm: 'DELETE' },
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('needs the exact confirmation and changes nothing without it', async () => {
    // null, not undefined: undefined would fall back to deleteWith's own valid default. A fresh
    // passenger per input, since every attempt (valid or not) counts against the rate limit.
    for (const input of [null, {}, { confirm: 'delete' }, { confirm: true }]) {
      const p = await passenger();
      await expect(deleteWith(p, undefined, input)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
      expect(await userExists(p.uid)).toBe(true);
      expect(await authExists(p.uid)).toBe(true);
    }
  });

  it('rate limits repeated attempts, even a correctly confirmed one, changing nothing', async () => {
    const p = await passenger();
    for (let i = 0; i < 3; i += 1) {
      await expect(deleteWith(p, undefined, null)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    }
    await expect(deleteWith(p, undefined)).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(await userExists(p.uid)).toBe(true);
    expect(await authExists(p.uid)).toBe(true);
  });

  it.each([
    ['an open ride', { status: 'SEARCHING', paymentStatus: null, endedAt: null }],
    ['a ride in progress', { status: 'IN_TRANSIT', paymentStatus: null, endedAt: null }],
    ['an outstanding payment hold', { status: 'CANCELLED', paymentStatus: 'AUTHORIZED' }],
    [
      'an unreviewed dispute',
      { status: 'COMPLETED', paymentStatus: 'DISPUTED', disputeReviewed: false },
    ],
  ])('refuses while there is %s, changing nothing', async (_name, fields) => {
    const p = await passenger({ stripeCustomerId: 'cus_keep' });
    const tripId = await trip(p.uid, fields);
    const { provider, deleted } = fakeStripe();

    await expect(deleteWith(p, provider)).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(deleted).toEqual([]);
    expect(await userExists(p.uid)).toBe(true);
    expect(await authExists(p.uid)).toBe(true);
    expect((await tripData(tripId)).passengerId).toBe(p.uid);
    // Leave no in-flight request behind for the shared emulator's global batch runs.
    await admin()
      .firestore.collection('tripRequests')
      .doc(tripId)
      .update({ status: 'CANCELLED', paymentStatus: null });
  });

  it('goes ahead once a dispute has been reviewed', async () => {
    const p = await passenger();
    await trip(p.uid, { paymentStatus: 'DISPUTED', disputeReviewed: true });
    await expect(deleteWith(p, undefined)).resolves.toEqual({ status: 'deleted' });
  });

  it('refuses, changing nothing, when a Stripe customer exists but Stripe is not available', async () => {
    const p = await passenger({ stripeCustomerId: 'cus_keep' });
    await expect(deleteWith(p, undefined)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await userExists(p.uid)).toBe(true);
    expect(await authExists(p.uid)).toBe(true);
  });

  it('refuses, changing nothing, when Stripe fails to delete the customer', async () => {
    const p = await passenger({ stripeCustomerId: 'cus_keep' });
    const tripId = await trip(p.uid);
    const { provider } = fakeStripe({ deleteCustomer: async () => ({ status: 'failed' }) });

    await expect(deleteWith(p, provider)).rejects.toMatchObject({ code: 'unavailable' });

    expect(await userExists(p.uid)).toBe(true);
    expect(await authExists(p.uid)).toBe(true);
    expect((await tripData(tripId)).passengerId).toBe(p.uid);
  });

  it('deletes the account, the Stripe customer, the profile and the notifications', async () => {
    const p = await passenger({ stripeCustomerId: 'cus_gone', paymentMethodId: 'pm_gone' });
    await notification(p.uid, 'one');
    await notification(p.uid, 'two');
    const { provider, deleted } = fakeStripe();

    await expect(deleteWith(p, provider)).resolves.toEqual({ status: 'deleted' });

    expect(deleted).toEqual(['cus_gone']);
    expect(await userExists(p.uid)).toBe(false);
    expect(await authExists(p.uid)).toBe(false);
    const left = await admin()
      .firestore.collection('notifications')
      .where('recipientId', '==', p.uid)
      .get();
    expect(left.size).toBe(0);
  });

  it('anonymizes trips and receipts, keeping the financial record', async () => {
    const p = await passenger();
    const tripId = await trip(p.uid);
    await receipt(p.uid, tripId);

    await deleteWith(p, undefined);

    const data = await tripData(tripId);
    expect(data).toMatchObject({
      passengerId: null,
      passengerName: DELETED_PASSENGER_NAME,
      origin: null,
      destination: null,
      driverLocation: null,
      placesCleared: true,
      // Kept: fares, payments and disputes still need them.
      status: 'COMPLETED',
      finalFareMinorUnits: 1250,
      paymentStatus: 'CAPTURED',
      paymentIntentId: 'pi_secret',
    });
    const receipts = await admin()
      .firestore.collection('receipts')
      .where('tripId', '==', tripId)
      .get();
    expect(receipts.size).toBe(1);
    expect(receipts.docs[0]?.get('passengerId')).toBeNull();
    expect(receipts.docs[0]?.get('totalMinorUnits')).toBe(1250);
  });

  it('leaves another passenger records alone', async () => {
    const mine = await passenger();
    const other = await passenger();
    const otherTrip = await trip(other.uid);
    await notification(other.uid, 'keep me');

    await deleteWith(mine, undefined);

    expect((await tripData(otherTrip)).passengerId).toBe(other.uid);
    expect(await userExists(other.uid)).toBe(true);
    expect(await authExists(other.uid)).toBe(true);
    const kept = await admin()
      .firestore.collection('notifications')
      .where('recipientId', '==', other.uid)
      .get();
    expect(kept.size).toBe(1);
  });

  it('audits the deletion with the uid only, never a name or email', async () => {
    const p = await passenger();
    await deleteWith(p, undefined);
    const entries = await auditsFor(p.uid, 'ACCOUNT_DELETED');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: p.uid });
    const text = JSON.stringify(entries[0]);
    expect(text).not.toContain(p.email);
    expect(text).not.toContain('Rights Person');
  });

  it('finishes a half-done deletion when called again', async () => {
    const p = await passenger({ stripeCustomerId: 'cus_retry' });
    const tripId = await trip(p.uid);
    // The earlier attempt got as far as removing the profile and the sign-in account.
    await admin().firestore.collection('users').doc(p.uid).delete();
    await admin().auth.deleteUser(p.uid);

    await expect(deleteWith(p, undefined)).resolves.toEqual({ status: 'deleted' });
    expect((await tripData(tripId)).passengerId).toBeNull();
  });

  it('retries cleanly when the Stripe customer was already deleted on an earlier attempt', async () => {
    const p = await passenger({ stripeCustomerId: 'cus_twice' });
    const { provider } = fakeStripe();
    await deleteWith(p, provider);
    // Same call again: profile and sign-in account are gone, the function must still succeed.
    await expect(deleteWith(p, provider)).resolves.toEqual({ status: 'deleted' });
  });
});

describe('through the real callables and the client wrappers', () => {
  async function signedInPassenger(prefix: string) {
    const client = createClient();
    const { user, uid, email } = await signUp(client, prefix);
    await admin().auth.setCustomUserClaims(uid, { role: 'PASSENGER' });
    await verifyEmail(user, email);
    await admin().firestore.collection('users').doc(uid).set({
      role: 'PASSENGER',
      name: 'Wrapper Person',
      email,
      phone: null,
      photoUrl: null,
      status: 'ACTIVE',
      statusReason: null,
      pushToken: null,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    return { client, uid, email };
  }

  it('exports and then deletes', async () => {
    const p = await signedInPassenger('rights-wrapper');
    const tripId = await trip(p.uid);

    const data = await exportMyDataClient(p.client);
    expect(data.profile.email).toBe(p.email);
    expect(data.trips).toEqual([expect.objectContaining({ tripId })]);

    expect(await deleteMyAccountClient(p.client)).toBe('deleted');
    expect(await userExists(p.uid)).toBe(false);
    expect(await authExists(p.uid)).toBe(false);
    expect((await tripData(tripId)).passengerId).toBeNull();
  });

  // A driver now gets their own export (driverDataRights.int.test.ts); a staff account has neither.
  it('refuses a staff account', async () => {
    const client = createClient();
    const { user, uid, email } = await signUp(client, 'rights-staff');
    await admin().auth.setCustomUserClaims(uid, { role: 'ADMIN' });
    await verifyEmail(user, email);
    await expect(exportMyDataClient(client)).rejects.toMatchObject({
      code: 'functions/permission-denied',
    });
  });
});
