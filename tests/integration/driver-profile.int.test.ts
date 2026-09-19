import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import {
  subscribeToDriverProfile,
  registerAccount,
  type DriverProfileSnapshot,
} from '../../packages/firebase/src';
import { PASSWORD, admin, createClient, signUp, uniqueEmail, verifyEmail } from './support';

const root = resolve(__dirname, '../..');

function completeRegistration(client: ReturnType<typeof createClient>, data: unknown) {
  return httpsCallable(client.functions, 'completeRegistration')(data);
}

function runBackfill(env: NodeJS.ProcessEnv = process.env) {
  try {
    const output = execFileSync(
      process.execPath,
      [join(root, 'scripts/backfill-driver-profiles.mjs')],
      { env, encoding: 'utf8', stdio: 'pipe' },
    );
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status: number; stderr: string; stdout: string };
    return { status: failure.status, output: `${failure.stdout}${failure.stderr}` };
  }
}

const stored = async (uid: string) => (await admin().firestore.doc(`drivers/${uid}`).get()).data();

const auditFor = async (uid: string) =>
  (await admin().firestore.collection('auditLogs').where('entity', '==', `drivers/${uid}`).get())
    .docs;

describe('driver profile creation (functions + firestore emulators)', () => {
  it('creates drivers/{uid} with safe defaults when a driver registers', async () => {
    const client = createClient();
    const { uid } = await signUp(client, 'driver-new');
    await completeRegistration(client, { role: 'DRIVER', name: 'Dan' });

    expect(await stored(uid)).toMatchObject({
      userId: uid,
      verificationStatus: 'PENDING',
      availabilityStatus: 'OFFLINE',
      rating: null,
      totalTrips: 0,
      maxDetourMinutes: null,
      maxDetourDistance: null,
      automaticMatchingEnabled: null,
    });
    expect((await stored(uid))?.createdAt).toBeDefined();
    expect((await stored(uid))?.updatedAt).toBeDefined();

    const audit = await auditFor(uid);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.data()).toMatchObject({
      actor: uid,
      action: 'DRIVER_PROFILE_CREATED',
      previousState: null,
      newState: { verificationStatus: 'PENDING' },
    });
  });

  it('creates no driver profile for a passenger', async () => {
    const client = createClient();
    const { uid } = await signUp(client, 'passenger-none');
    await completeRegistration(client, { role: 'PASSENGER', name: 'Pat' });

    expect(await stored(uid)).toBeUndefined();
    expect(await auditFor(uid)).toHaveLength(0);
  });

  it('is safe to repeat: one profile, one audit entry, nothing overwritten', async () => {
    const client = createClient();
    const { uid } = await signUp(client, 'driver-twice');
    await completeRegistration(client, { role: 'DRIVER', name: 'Dan' });
    await admin().firestore.doc(`drivers/${uid}`).update({ totalTrips: 7 });
    await completeRegistration(client, { role: 'DRIVER', name: 'Dan' });

    expect((await stored(uid))?.totalTrips).toBe(7);
    expect(await auditFor(uid)).toHaveLength(1);
  });

  it('does not create a driver profile when a role change is refused', async () => {
    const client = createClient();
    const { uid } = await signUp(client, 'passenger-switch');
    await completeRegistration(client, { role: 'PASSENGER', name: 'Pat' });
    await expect(
      completeRegistration(client, { role: 'DRIVER', name: 'Pat' }),
    ).rejects.toMatchObject({ code: 'functions/failed-precondition' });
    expect(await stored(uid)).toBeUndefined();
  });

  it('repairs a driver whose profile is missing when registration is repeated', async () => {
    const client = createClient();
    const { uid } = await signUp(client, 'driver-repair');
    await completeRegistration(client, { role: 'DRIVER', name: 'Dan' });
    await admin().firestore.doc(`drivers/${uid}`).delete();

    await completeRegistration(client, { role: 'DRIVER', name: 'Dan' });
    expect((await stored(uid))?.verificationStatus).toBe('PENDING');
    expect(await auditFor(uid)).toHaveLength(2);
  });

  it('works end to end through the app registration flow', async () => {
    const client = createClient();
    const email = uniqueEmail('driver-app');
    await registerAccount(client, {
      role: 'DRIVER',
      values: {
        name: 'Dan Driver',
        email,
        phone: '',
        password: PASSWORD,
        confirmPassword: PASSWORD,
      },
    });
    expect((await stored(client.auth.currentUser!.uid))?.verificationStatus).toBe('PENDING');
  });
});

describe('reading and writing the driver profile as the driver (real auth tokens)', () => {
  async function verifiedDriver(prefix: string) {
    const client = createClient();
    const { user, uid, email } = await signUp(client, prefix);
    await completeRegistration(client, { role: 'DRIVER', name: 'Dan' });
    await verifyEmail(user, email);
    return { client, uid };
  }

  it('lets a driver follow their own profile live and see a change', async () => {
    const { client, uid } = await verifiedDriver('driver-live');
    const snapshots: DriverProfileSnapshot[] = [];
    const unsubscribe = subscribeToDriverProfile(
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
        .toMatchObject({
          status: 'ready',
          driver: { verificationStatus: 'PENDING', rating: null, totalTrips: 0 },
        });

      await admin().firestore.doc(`drivers/${uid}`).update({ verificationStatus: 'VERIFIED' });
      await expect
        .poll(() => snapshots.at(-1))
        .toMatchObject({
          status: 'ready',
          driver: { verificationStatus: 'VERIFIED' },
        });
    } finally {
      unsubscribe();
    }
  });

  it('reports a missing profile', async () => {
    const { client, uid } = await verifiedDriver('driver-gone');
    await admin().firestore.doc(`drivers/${uid}`).delete();
    const snapshots: DriverProfileSnapshot[] = [];
    const unsubscribe = subscribeToDriverProfile(
      client,
      uid,
      (s) => snapshots.push(s),
      () => {},
    );
    try {
      await expect.poll(() => snapshots.at(-1)).toEqual({ status: 'missing' });
    } finally {
      unsubscribe();
    }
  });

  it('refuses another driver and refuses every client write', async () => {
    const first = await verifiedDriver('driver-a');
    const second = await verifiedDriver('driver-b');

    await expect(getDoc(doc(second.client.db, `drivers/${first.uid}`))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(
      updateDoc(doc(first.client.db, `drivers/${first.uid}`), { verificationStatus: 'VERIFIED' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      setDoc(doc(first.client.db, `drivers/${first.uid}`), { verificationStatus: 'VERIFIED' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await stored(first.uid))?.verificationStatus).toBe('PENDING');
  });
});

describe('backfill script (service account)', () => {
  it('creates missing driver profiles only, and can be run again', async () => {
    const { firestore } = admin();
    const client = createClient();
    const legacy = await signUp(client, 'legacy-driver');
    await completeRegistration(client, { role: 'DRIVER', name: 'Old Dan' });
    await firestore.doc(`drivers/${legacy.uid}`).delete();
    // Audit entries from the registration above stay; only new ones are counted below.
    const before = (await auditFor(legacy.uid)).length;

    const kept = await signUp(createClient(), 'kept-driver');
    await firestore
      .doc(`users/${kept.uid}`)
      .set({ role: 'DRIVER', name: 'Kept', status: 'ACTIVE' });
    await firestore.doc(`drivers/${kept.uid}`).set({ userId: kept.uid, totalTrips: 3 });

    const passenger = await signUp(createClient(), 'legacy-passenger');
    await firestore.doc(`users/${passenger.uid}`).set({ role: 'PASSENGER', name: 'Pat' });

    const first = runBackfill();
    expect(first.status).toBe(0);
    expect(first.output).toContain('created');

    expect((await stored(legacy.uid))?.verificationStatus).toBe('PENDING');
    expect((await stored(kept.uid))?.totalTrips).toBe(3);
    expect(await stored(passenger.uid)).toBeUndefined();

    const audit = await auditFor(legacy.uid);
    expect(audit).toHaveLength(before + 1);
    expect(audit.at(-1)?.data()).toBeDefined();
    expect(audit.some((entry) => entry.get('actor') === 'script:backfill-driver-profiles')).toBe(
      true,
    );

    const second = runBackfill();
    expect(second.status).toBe(0);
    expect(second.output).toContain('created 0 driver profile(s)');
    expect(await auditFor(legacy.uid)).toHaveLength(before + 1);
  });

  it('refuses to run against the real project without explicit confirmation', () => {
    const env = { ...process.env };
    delete env.FIRESTORE_EMULATOR_HOST;
    const run = runBackfill(env);
    expect(run.status).toBe(1);
    expect(run.output).toContain('--confirm-production');
  });
});
