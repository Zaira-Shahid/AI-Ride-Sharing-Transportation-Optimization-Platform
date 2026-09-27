import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import { listPassengersForReview, submitUserStatus } from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

// Module 11.3 (admin dashboard: user management). setUserStatus's own new write path - every OTHER
// module already tests that status !== 'ACTIVE' actually blocks a passenger/driver action (trip
// requests, journeys, locations, payment methods, verification's own requestReview all have their own
// SUSPENDED-account test elsewhere); this file only exercises what's NEW here: the write itself, who
// may call it, and the client wrapper (listPassengersForReview, submitUserStatus) - the same split
// staffSignIn.int.test.ts/adminReview.int.test.ts already took for their own modules.

const call = (client: Client, name: string, data: unknown) =>
  httpsCallable(client.functions, name)(data);

async function person(role: 'DRIVER' | 'PASSENGER', prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
  await verifyEmail(user, email);
  return { client, uid, email };
}

// Mirrors what functions/src/staff.ts's own assignStaffRole (the real production path, only ever
// called from scripts/set-staff-role.mjs) writes: a real users/{uid} doc with role: <StaffRole>, the
// same as every real staff account has. Needed here (unlike verification.int.test.ts's own simpler
// `staff()` helper) because setUserStatus reads the target's own users doc, not just the auth claim.
async function staff(role: string, prefix: string, verified = true) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await admin().auth.setCustomUserClaims(uid, { role });
  await admin().firestore.doc(`users/${uid}`).set({
    role,
    name: 'Test Staff',
    email,
    phone: null,
    photoUrl: null,
    status: 'ACTIVE',
    statusReason: null,
    pushToken: null,
  });
  if (verified) await verifyEmail(user, email);
  else await user.getIdToken(true);
  return { client, uid, email };
}

const userDoc = async (uid: string) => (await admin().firestore.doc(`users/${uid}`).get()).data();
const auditOf = async (entity: string, action: string) =>
  (
    await admin()
      .firestore.collection('auditLogs')
      .where('entity', '==', entity)
      .where('action', '==', action)
      .get()
  ).docs;

describe('setUserStatus (functions + firestore + auth emulators)', () => {
  it.each(['ADMIN', 'SUPER_ADMIN'])(
    'lets %s suspend and reinstate a passenger, and audits it',
    async (role) => {
      const reviewer = await staff(role, 'setstatus-reviewer');
      const target = await person('PASSENGER', 'setstatus-target');

      const suspended = await call(reviewer.client, 'setUserStatus', {
        userId: target.uid,
        status: 'SUSPENDED',
        reason: 'Reported for harassment.',
      });
      expect(suspended.data).toEqual({ status: 'changed' });
      expect(await userDoc(target.uid)).toMatchObject({
        status: 'SUSPENDED',
        statusReason: 'Reported for harassment.',
      });

      const reinstated = await call(reviewer.client, 'setUserStatus', {
        userId: target.uid,
        status: 'ACTIVE',
      });
      expect(reinstated.data).toEqual({ status: 'changed' });
      expect(await userDoc(target.uid)).toMatchObject({ status: 'ACTIVE', statusReason: null });

      const entries = await auditOf(`users/${target.uid}`, 'USER_STATUS_CHANGED');
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.get('actor'))).toEqual([reviewer.uid, reviewer.uid]);
    },
  );

  it('refuses a suspension with no reason, a blank reason, or an oversized reason', async () => {
    const reviewer = await staff('ADMIN', 'setstatus-noreason');
    const target = await person('PASSENGER', 'setstatus-noreason-t');
    for (const reason of [undefined, '   ', 'x'.repeat(501)]) {
      await expect(
        call(reviewer.client, 'setUserStatus', { userId: target.uid, status: 'SUSPENDED', reason }),
      ).rejects.toMatchObject({ code: 'functions/invalid-argument' });
    }
    expect((await userDoc(target.uid))?.status).toBe('ACTIVE');
  });

  it('changes nothing when the same status and reason are repeated', async () => {
    const reviewer = await staff('ADMIN', 'setstatus-repeat');
    const target = await person('PASSENGER', 'setstatus-repeat-t');
    const input = { userId: target.uid, status: 'SUSPENDED', reason: 'Chargeback fraud.' };
    await call(reviewer.client, 'setUserStatus', input);

    const again = await call(reviewer.client, 'setUserStatus', input);
    expect(again.data).toEqual({ status: 'unchanged' });
    expect(await auditOf(`users/${target.uid}`, 'USER_STATUS_CHANGED')).toHaveLength(1);
  });

  it('refuses a driver or a staff account - only passengers are managed here', async () => {
    const reviewer = await staff('ADMIN', 'setstatus-notpassenger');
    const driver = await person('DRIVER', 'setstatus-driver');
    const otherStaff = await staff('SUPPORT', 'setstatus-staff-target');

    for (const target of [driver, otherStaff]) {
      await expect(
        call(reviewer.client, 'setUserStatus', {
          userId: target.uid,
          status: 'SUSPENDED',
          reason: 'Test.',
        }),
      ).rejects.toMatchObject({ code: 'functions/failed-precondition' });
    }
  });

  it('reports an account that does not exist', async () => {
    const reviewer = await staff('ADMIN', 'setstatus-missing');
    await expect(
      call(reviewer.client, 'setUserStatus', {
        userId: 'nobody-here',
        status: 'SUSPENDED',
        reason: 'Test.',
      }),
    ).rejects.toMatchObject({ code: 'functions/not-found' });
  });

  it('refuses everyone but verified ADMIN and SUPER_ADMIN', async () => {
    const target = await person('PASSENGER', 'setstatus-who-t');
    const input = { userId: target.uid, status: 'SUSPENDED', reason: 'Test.' };

    await expect(call(createClient(), 'setUserStatus', input)).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });

    const refused = [
      await staff('OPERATIONS', 'setstatus-ops'),
      await staff('SUPPORT', 'setstatus-support'),
      await staff('ADMIN', 'setstatus-unverified', false),
      await person('DRIVER', 'setstatus-other-driver'),
      target,
    ];
    for (const caller of refused) {
      await expect(call(caller.client, 'setUserStatus', input)).rejects.toMatchObject({
        code: 'functions/permission-denied',
      });
    }
    expect((await userDoc(target.uid))?.status).toBe('ACTIVE');
  });
});

describe('listPassengersForReview / submitUserStatus (client wrapper)', () => {
  it('lists a passenger, suspended ones first', async () => {
    const reviewer = await staff('ADMIN', 'listpass-reviewer');
    const active = await person('PASSENGER', 'listpass-active');
    const suspended = await person('PASSENGER', 'listpass-suspended');
    await submitUserStatus(reviewer.client, suspended.uid, 'SUSPENDED', 'Test suspension.');

    const rows = await listPassengersForReview(reviewer.client);
    const activeRow = rows.find((row) => row.uid === active.uid);
    const suspendedRow = rows.find((row) => row.uid === suspended.uid);

    expect(activeRow).toMatchObject({ email: active.email, status: 'ACTIVE' });
    expect(suspendedRow).toMatchObject({ status: 'SUSPENDED', statusReason: 'Test suspension.' });
    expect(rows.indexOf(suspendedRow!)).toBeLessThan(rows.indexOf(activeRow!));
    expect(rows.some((row) => row.uid === reviewer.uid)).toBe(false);
  });

  it('turns a permission-denied refusal into a clear message, for a non-reviewer staff role', async () => {
    const support = await staff('SUPPORT', 'listpass-support');
    const target = await person('PASSENGER', 'listpass-support-t');

    await expect(
      submitUserStatus(support.client, target.uid, 'SUSPENDED', 'Test.'),
    ).rejects.toMatchObject({ message: 'You are not allowed to manage user accounts.' });
  });
});
