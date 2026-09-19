import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { doc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  describeAuthError,
  requestReview,
  saveVehicle,
  setVehicleCapacity,
  subscribeToDriverProfile,
  type DriverProfileSnapshot,
} from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

const root = resolve(__dirname, '../..');
let plateCounter = 0;
const uniquePlate = () => `VER-${Date.now() % 100000}-${plateCounter++}`;

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

/** A staff account, made the way the staff script makes one: a server-set role claim. */
async function staff(role: string, prefix: string, verified = true) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await admin().auth.setCustomUserClaims(uid, { role });
  if (verified) await verifyEmail(user, email);
  else await user.getIdToken(true);
  return { client, uid };
}

/** A verified driver with a driver profile and a vehicle. */
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
const vehicleDoc = async (uid: string) =>
  (await admin().firestore.doc(`vehicles/${uid}`).get()).data();
const auditOf = async (entity: string, action: string) =>
  (
    await admin()
      .firestore.collection('auditLogs')
      .where('entity', '==', entity)
      .where('action', '==', action)
      .get()
  ).docs;

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

describe('staff verifying a driver (functions + auth + firestore emulators)', () => {
  it.each(['ADMIN', 'SUPER_ADMIN'])('lets %s verify a driver, and audits it', async (role) => {
    const reviewer = await staff(role, 'rev-driver');
    const target = await driver('rev-target');

    const result = await call(reviewer.client, 'reviewDriver', {
      driverId: target.uid,
      decision: 'VERIFIED',
    });
    expect(result.data).toEqual({ status: 'reviewed' });

    expect(await driverDoc(target.uid)).toMatchObject({
      verificationStatus: 'VERIFIED',
      verificationReason: null,
      rating: null,
      totalTrips: 0,
      availabilityStatus: 'OFFLINE',
    });
    expect((await driverDoc(target.uid))?.verificationReviewedAt).toBeDefined();

    const entries = await auditOf(`drivers/${target.uid}`, 'DRIVER_VERIFICATION_REVIEWED');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data()).toMatchObject({
      actor: reviewer.uid,
      previousState: { verificationStatus: 'PENDING', verificationReason: null },
      newState: { verificationStatus: 'VERIFIED', verificationReason: null },
    });
  });

  it('rejects a driver with a reason the driver can then read', async () => {
    const reviewer = await staff('ADMIN', 'rev-reject');
    const target = await driver('rev-rejected');
    await call(reviewer.client, 'reviewDriver', {
      driverId: target.uid,
      decision: 'REJECTED',
      reason: '  Identity could not be confirmed.  ',
    });

    expect(await driverDoc(target.uid)).toMatchObject({
      verificationStatus: 'REJECTED',
      verificationReason: 'Identity could not be confirmed.',
    });

    const snapshots: DriverProfileSnapshot[] = [];
    const unsubscribe = subscribeToDriverProfile(
      target.client,
      target.uid,
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
          driver: {
            verificationStatus: 'REJECTED',
            verificationReason: 'Identity could not be confirmed.',
          },
        });
    } finally {
      unsubscribe();
    }
  });

  it.each([
    ['no reason', undefined],
    ['a blank reason', '   '],
    ['an oversized reason', 'x'.repeat(501)],
  ])('refuses a rejection with %s', async (_label, reason) => {
    const reviewer = await staff('ADMIN', 'rev-noreason');
    const target = await driver('rev-noreason-t');
    await expect(
      call(reviewer.client, 'reviewDriver', { driverId: target.uid, decision: 'REJECTED', reason }),
    ).rejects.toMatchObject({ code: 'functions/invalid-argument' });
    expect((await driverDoc(target.uid))?.verificationStatus).toBe('PENDING');
  });

  it.each([
    ['an unknown decision', { decision: 'APPROVED' }],
    ['a decision of PENDING', { decision: 'PENDING' }],
    ['no decision', { decision: undefined }],
    ['a path instead of an id', { driverId: 'users/someone' }],
    ['a parent path', { driverId: '..' }],
    ['a blank id', { driverId: '  ' }],
  ])('refuses %s', async (_label, override) => {
    const reviewer = await staff('ADMIN', 'rev-invalid');
    const target = await driver('rev-invalid-t');
    await expect(
      call(reviewer.client, 'reviewDriver', {
        driverId: target.uid,
        decision: 'VERIFIED',
        ...override,
      }),
    ).rejects.toMatchObject({ code: 'functions/invalid-argument' });
    expect((await driverDoc(target.uid))?.verificationStatus).toBe('PENDING');
  });

  it('changes nothing when the same decision is repeated', async () => {
    const reviewer = await staff('ADMIN', 'rev-repeat');
    const target = await driver('rev-repeat-t');
    const input = { driverId: target.uid, decision: 'VERIFIED' };
    await call(reviewer.client, 'reviewDriver', input);

    const again = await call(reviewer.client, 'reviewDriver', input);
    expect(again.data).toEqual({ status: 'unchanged' });
    expect(await auditOf(`drivers/${target.uid}`, 'DRIVER_VERIFICATION_REVIEWED')).toHaveLength(1);
  });

  it('lets staff change their mind: reject a verified driver, then verify again', async () => {
    const reviewer = await staff('SUPER_ADMIN', 'rev-mind');
    const target = await driver('rev-mind-t');
    const review = (decision: string, reason?: string) =>
      call(reviewer.client, 'reviewDriver', { driverId: target.uid, decision, reason });

    await review('VERIFIED');
    await review('REJECTED', 'Licence expired.');
    expect(await driverDoc(target.uid)).toMatchObject({
      verificationStatus: 'REJECTED',
      verificationReason: 'Licence expired.',
    });

    // A new reason is a change; the old one is recorded in the audit trail.
    expect((await review('REJECTED', 'Licence expired and photo unclear.')).data).toEqual({
      status: 'reviewed',
    });
    await review('VERIFIED', 'ignored on approval');
    expect(await driverDoc(target.uid)).toMatchObject({
      verificationStatus: 'VERIFIED',
      verificationReason: null,
    });
    expect(await auditOf(`drivers/${target.uid}`, 'DRIVER_VERIFICATION_REVIEWED')).toHaveLength(4);
  });

  it('reports a driver that does not exist', async () => {
    const reviewer = await staff('ADMIN', 'rev-missing');
    const passenger = await person('PASSENGER', 'rev-passenger');
    for (const driverId of ['nobody-here', passenger.uid]) {
      await expect(
        call(reviewer.client, 'reviewDriver', { driverId, decision: 'VERIFIED' }),
      ).rejects.toMatchObject({ code: 'functions/not-found' });
    }
  });
});

describe('staff verifying a vehicle', () => {
  it('verifies and rejects a vehicle independently of the driver', async () => {
    const reviewer = await staff('ADMIN', 'rev-veh');
    const target = await driver('rev-veh-t');

    await call(reviewer.client, 'reviewVehicle', { driverId: target.uid, decision: 'VERIFIED' });
    expect((await vehicleDoc(target.uid))?.verificationStatus).toBe('VERIFIED');
    expect((await driverDoc(target.uid))?.verificationStatus).toBe('PENDING');

    await call(reviewer.client, 'reviewVehicle', {
      driverId: target.uid,
      decision: 'REJECTED',
      reason: 'Plate does not match the vehicle.',
    });
    expect(await vehicleDoc(target.uid)).toMatchObject({
      verificationStatus: 'REJECTED',
      verificationReason: 'Plate does not match the vehicle.',
    });
    expect((await driverDoc(target.uid))?.verificationStatus).toBe('PENDING');

    const entries = await auditOf(`vehicles/${target.uid}`, 'VEHICLE_VERIFICATION_REVIEWED');
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.get('actor'))).toEqual([reviewer.uid, reviewer.uid]);
  });

  it('reports a vehicle that does not exist yet', async () => {
    const reviewer = await staff('ADMIN', 'rev-noveh');
    const target = await person('DRIVER', 'rev-noveh-t');
    await expect(
      call(reviewer.client, 'reviewVehicle', { driverId: target.uid, decision: 'VERIFIED' }),
    ).rejects.toMatchObject({ code: 'functions/not-found' });
  });

  it('starts a new review when the driver changes the vehicle after a rejection', async () => {
    const reviewer = await staff('ADMIN', 'rev-veh-edit');
    const target = await driver('rev-veh-edit-t');
    await call(reviewer.client, 'reviewVehicle', {
      driverId: target.uid,
      decision: 'REJECTED',
      reason: 'Wrong model.',
    });

    await saveVehicle(target.client, {
      type: 'CAR',
      make: 'Toyota',
      model: 'Yaris',
      plateNumber: uniquePlate(),
    });
    expect(await vehicleDoc(target.uid)).toMatchObject({
      verificationStatus: 'PENDING',
      verificationReason: null,
      verificationReviewedAt: null,
    });
  });

  it('clears an old decision when seats go up, and keeps a rejection when they go down', async () => {
    const reviewer = await staff('ADMIN', 'rev-seats');
    const target = await driver('rev-seats-t');
    await setVehicleCapacity(target.client, 4);

    await call(reviewer.client, 'reviewVehicle', {
      driverId: target.uid,
      decision: 'REJECTED',
      reason: 'Too few seats for this model.',
    });
    await setVehicleCapacity(target.client, 3);
    expect(await vehicleDoc(target.uid)).toMatchObject({
      verificationStatus: 'REJECTED',
      verificationReason: 'Too few seats for this model.',
    });

    await setVehicleCapacity(target.client, 5);
    expect(await vehicleDoc(target.uid)).toMatchObject({
      verificationStatus: 'PENDING',
      verificationReason: null,
    });
  });
});

describe('who may review', () => {
  it('refuses everyone but verified ADMIN and SUPER_ADMIN', async () => {
    const target = await driver('rev-who-t');
    const input = { driverId: target.uid, decision: 'VERIFIED' };

    await expect(call(createClient(), 'reviewDriver', input)).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });

    const refused = [
      await staff('OPERATIONS', 'rev-ops'),
      await staff('SUPPORT', 'rev-support'),
      await staff('ADMIN', 'rev-unverified', false),
      await person('DRIVER', 'rev-other-driver'),
      await person('PASSENGER', 'rev-pass'),
      target,
    ];
    for (const caller of refused) {
      for (const name of ['reviewDriver', 'reviewVehicle']) {
        await expect(call(caller.client, name, input)).rejects.toMatchObject({
          code: 'functions/permission-denied',
        });
      }
    }
    expect((await driverDoc(target.uid))?.verificationStatus).toBe('PENDING');
    expect((await vehicleDoc(target.uid))?.verificationStatus).toBe('PENDING');
  });

  it('does not trust a role stored in a document', async () => {
    const forger = await person('PASSENGER', 'rev-forger');
    await admin().firestore.doc(`users/${forger.uid}`).update({ role: 'SUPER_ADMIN' });
    const target = await driver('rev-forger-t');
    await expect(
      call(forger.client, 'reviewDriver', { driverId: target.uid, decision: 'VERIFIED' }),
    ).rejects.toMatchObject({ code: 'functions/permission-denied' });
  });

  it('cannot be bypassed by writing the verification fields directly', async () => {
    const target = await driver('rev-direct');
    for (const fields of [
      { verificationStatus: 'VERIFIED' },
      { verificationReason: 'fine', verificationStatus: 'VERIFIED' },
    ]) {
      await expect(
        updateDoc(doc(target.client.db, `drivers/${target.uid}`), fields),
      ).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(
        updateDoc(doc(target.client.db, `vehicles/${target.uid}`), fields),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    }
    expect((await driverDoc(target.uid))?.verificationStatus).toBe('PENDING');
  });
});

describe('a driver asking for a new review', () => {
  it.each([
    ['DRIVER', 'reviewDriver', driverDoc],
    ['VEHICLE', 'reviewVehicle', vehicleDoc],
  ] as const)('sends a rejected %s back to pending', async (target, reviewFunction, read) => {
    const reviewer = await staff('ADMIN', 'ask-reviewer');
    const person_ = await driver('ask-driver');
    await call(reviewer.client, reviewFunction, {
      driverId: person_.uid,
      decision: 'REJECTED',
      reason: 'Please try again.',
    });

    expect(await requestReview(person_.client, target)).toBe('requested');
    expect(await read(person_.uid)).toMatchObject({
      verificationStatus: 'PENDING',
      verificationReason: null,
      verificationReviewedAt: null,
    });

    const entries = await auditOf(
      `${target === 'DRIVER' ? 'drivers' : 'vehicles'}/${person_.uid}`,
      `${target}_REVIEW_REQUESTED`,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data()).toMatchObject({
      actor: person_.uid,
      previousState: { verificationStatus: 'REJECTED', verificationReason: 'Please try again.' },
      newState: { verificationStatus: 'PENDING', verificationReason: null },
    });
  });

  it('never moves a pending or verified profile, so it cannot be used to self-verify', async () => {
    const reviewer = await staff('ADMIN', 'ask-noop-reviewer');
    const person_ = await driver('ask-noop');

    expect(await requestReview(person_.client, 'DRIVER')).toBe('unchanged');
    expect((await driverDoc(person_.uid))?.verificationStatus).toBe('PENDING');

    await call(reviewer.client, 'reviewDriver', { driverId: person_.uid, decision: 'VERIFIED' });
    expect(await requestReview(person_.client, 'DRIVER')).toBe('unchanged');
    expect((await driverDoc(person_.uid))?.verificationStatus).toBe('VERIFIED');
    expect(await auditOf(`drivers/${person_.uid}`, 'DRIVER_REVIEW_REQUESTED')).toHaveLength(0);
  });

  it('only ever touches the caller own records', async () => {
    const reviewer = await staff('ADMIN', 'ask-own-reviewer');
    const mine = await driver('ask-mine');
    const theirs = await driver('ask-theirs');
    for (const person_ of [mine, theirs]) {
      await call(reviewer.client, 'reviewDriver', {
        driverId: person_.uid,
        decision: 'REJECTED',
        reason: 'No.',
      });
    }
    await call(mine.client, 'requestReview', { target: 'DRIVER', driverId: theirs.uid });
    expect((await driverDoc(mine.uid))?.verificationStatus).toBe('PENDING');
    expect((await driverDoc(theirs.uid))?.verificationStatus).toBe('REJECTED');
  });

  it('refuses invalid requests and callers who are not verified drivers', async () => {
    const person_ = await driver('ask-invalid');
    for (const data of [{}, { target: 'PASSENGER' }, { target: 'vehicle' }]) {
      await expect(call(person_.client, 'requestReview', data)).rejects.toMatchObject({
        code: 'functions/invalid-argument',
      });
    }
    await expect(call(createClient(), 'requestReview', { target: 'DRIVER' })).rejects.toMatchObject(
      { code: 'functions/unauthenticated' },
    );

    const callers = [
      await person('PASSENGER', 'ask-pass'),
      await person('DRIVER', 'ask-unverified', false),
      await staff('ADMIN', 'ask-admin'),
    ];
    for (const caller of callers) {
      await expect(
        call(caller.client, 'requestReview', { target: 'DRIVER' }),
      ).rejects.toMatchObject({ code: 'functions/permission-denied' });
    }
  });

  it('refuses a driver with no vehicle yet, or a suspended account', async () => {
    const noVehicle = await person('DRIVER', 'ask-noveh');
    const error = await failureOf(requestReview(noVehicle.client, 'VEHICLE'));
    expect(describeAuthError(error).kind).toBe('permission');

    const suspended = await driver('ask-suspended');
    await admin().firestore.doc(`users/${suspended.uid}`).update({ status: 'SUSPENDED' });
    await expect(
      call(suspended.client, 'requestReview', { target: 'DRIVER' }),
    ).rejects.toMatchObject({ code: 'functions/failed-precondition' });
  });
});

function runReview(args: string[], env: NodeJS.ProcessEnv = process.env) {
  try {
    const output = execFileSync(
      process.execPath,
      [join(root, 'scripts/review-driver.mjs'), ...args],
      {
        env,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status: number; stderr: string; stdout: string };
    return { status: failure.status, output: `${failure.stdout}${failure.stderr}` };
  }
}

describe('review script (service account)', () => {
  it('verifies a driver and a vehicle by email, and audits the script as the actor', async () => {
    const target = await driver('script-ok');

    const driverRun = runReview(['driver', target.email, 'VERIFIED']);
    expect(driverRun.status).toBe(0);
    expect(driverRun.output).toContain('Set the driver');
    const vehicleRun = runReview(['vehicle', target.email, 'VERIFIED']);
    expect(vehicleRun.status).toBe(0);

    expect((await driverDoc(target.uid))?.verificationStatus).toBe('VERIFIED');
    expect((await vehicleDoc(target.uid))?.verificationStatus).toBe('VERIFIED');
    const entries = await auditOf(`drivers/${target.uid}`, 'DRIVER_VERIFICATION_REVIEWED');
    expect(entries[0]?.get('actor')).toBe('script:review-driver');

    expect(runReview(['driver', target.email, 'VERIFIED']).output).toContain('nothing changed');
  });

  it('rejects with a reason made of several words', async () => {
    const target = await driver('script-reject');
    const run = runReview(['vehicle', target.email, 'REJECTED', 'Photo', 'is', 'unclear.']);
    expect(run.status).toBe(0);
    expect(await vehicleDoc(target.uid)).toMatchObject({
      verificationStatus: 'REJECTED',
      verificationReason: 'Photo is unclear.',
    });
  });

  it('refuses a rejection without a reason, unknown accounts and bad usage', async () => {
    const target = await driver('script-bad');
    const noReason = runReview(['driver', target.email, 'REJECTED']);
    expect(noReason.status).toBe(1);
    expect((await driverDoc(target.uid))?.verificationStatus).toBe('PENDING');

    expect(runReview(['driver', 'nobody@example.test', 'VERIFIED']).status).toBe(1);
    expect(runReview(['driver', target.email, 'APPROVED']).status).toBe(1);
    const usage = runReview(['garage', target.email, 'VERIFIED']);
    expect(usage.status).toBe(1);
    expect(usage.output).toContain('Usage');
  });

  it('refuses to run against the real project without explicit confirmation', () => {
    const env = { ...process.env };
    delete env.FIREBASE_AUTH_EMULATOR_HOST;
    delete env.FIRESTORE_EMULATOR_HOST;
    const run = runReview(['driver', 'someone@example.test', 'VERIFIED'], env);
    expect(run.status).toBe(1);
    expect(run.output).toContain('--confirm-production');
  });
});
