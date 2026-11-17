import { Timestamp } from 'firebase-admin/firestore';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import type {
  AcceptInvitationResult,
  CreateCompanyResult,
  InviteEmployeeResult,
  ListEmployeesResult,
  ListInvitationsResult,
  RemoveEmployeeResult,
  RevokeInvitationResult,
  SetEmployeeRoleResult,
} from '../../packages/tenancy/src';
import { createCompany } from '../../functions/src/companies';
import {
  PASSWORD,
  admin,
  allPages,
  createClient,
  signUp,
  verifyEmail,
  type Client,
} from './support';

// Module A2a: company onboarding (functions + firestore + auth emulators). See
// docs/a2-company-onboarding-design.md.

const call = (client: Client, name: string, data?: unknown) =>
  httpsCallable(client.functions, name)(data);
const result = async <T>(client: Client, name: string, data?: unknown) =>
  (await call(client, name, data)).data as T;

const refused = (code: string, message?: string) => ({
  code: `functions/${code}`,
  ...(message ? { message: expect.stringContaining(message) as unknown as string } : {}),
});

interface Account {
  client: Client;
  uid: string;
  email: string;
  user: Awaited<ReturnType<typeof signUp>>['user'];
}

async function account(prefix: string, verified = true): Promise<Account> {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  if (verified) await verifyEmail(user, email);
  return { client, uid, email, user };
}

/** A verified account that has created a company, with its token refreshed to carry the claims. */
async function founder(prefix: string, name = 'Acme Ltd') {
  const acc = await account(prefix);
  const created = await result<CreateCompanyResult>(acc.client, 'createCompany', {
    name,
    ownerName: 'Founder Person',
  });
  await acc.user.getIdToken(true);
  return { ...acc, companyId: created.companyId };
}
type Founder = Awaited<ReturnType<typeof founder>>;

async function invite(by: Founder, email: string, companyRole?: 'COMPANY_ADMIN' | 'EMPLOYEE') {
  return result<InviteEmployeeResult>(by.client, 'inviteEmployee', { email, companyRole });
}

/** A new account invited by `by` and joined as `companyRole`, token refreshed. */
async function joined(by: Founder, prefix: string, companyRole?: 'COMPANY_ADMIN' | 'EMPLOYEE') {
  const acc = await account(prefix);
  const { code } = await invite(by, acc.email, companyRole);
  await result<AcceptInvitationResult>(acc.client, 'acceptInvitation', {
    code,
    name: 'New Person',
  });
  await acc.user.getIdToken(true);
  return { ...acc, companyId: by.companyId };
}

/** A removed person's tokens are revoked, so they sign in again for a fresh one. */
const signBackIn = async (acc: Account) => {
  await signInWithEmailAndPassword(acc.client.auth, acc.email, PASSWORD);
};

const firestore = () => admin().firestore;
const doc = async (path: string) => (await firestore().doc(path).get()).data();
const claimsOf = async (uid: string) => (await admin().auth.getUser(uid)).customClaims ?? {};
const auditOf = async (entity: string, action: string) =>
  (
    await firestore()
      .collection('auditLogs')
      .where('entity', '==', entity)
      .where('action', '==', action)
      .get()
  ).docs;

const INVALID = 'This invitation is not valid or has expired.';

describe('createCompany', () => {
  it('creates the company, its first administrator, the profile and the claims, and audits it', async () => {
    const acc = await account('create');
    const created = await result<CreateCompanyResult>(acc.client, 'createCompany', {
      name: '  Acme Ltd  ',
      ownerName: ' Founder ',
      phone: '+441234567',
    });
    expect(created.status).toBe('created');

    expect(await doc(`companies/${created.companyId}`)).toMatchObject({
      name: 'Acme Ltd',
      status: 'ACTIVE',
      createdBy: acc.uid,
    });
    expect(await doc(`companies/${created.companyId}/members/${acc.uid}`)).toMatchObject({
      companyRole: 'COMPANY_ADMIN',
      status: 'ACTIVE',
      canDrive: false,
      driverReviewedBy: null,
    });
    expect(await doc(`users/${acc.uid}`)).toMatchObject({
      role: 'EMPLOYEE',
      name: 'Founder',
      email: acc.email.toLowerCase(),
      phone: '+441234567',
      status: 'ACTIVE',
      companyId: created.companyId,
    });
    expect(await claimsOf(acc.uid)).toEqual({
      role: 'EMPLOYEE',
      companyId: created.companyId,
      companyRole: 'COMPANY_ADMIN',
    });
    expect(await auditOf(`companies/${created.companyId}`, 'COMPANY_CREATED')).toHaveLength(1);

    const token = await acc.user.getIdTokenResult(true);
    expect(token.claims).toMatchObject({
      role: 'EMPLOYEE',
      companyId: created.companyId,
      companyRole: 'COMPANY_ADMIN',
    });
  });

  it('is safe to repeat: the same company comes back and the claims are repaired', async () => {
    const acc = await founder('create-repeat');
    await admin().auth.setCustomUserClaims(acc.uid, {});
    const again = await result<CreateCompanyResult>(acc.client, 'createCompany', {
      name: 'Another Name',
      ownerName: 'Founder',
    });
    expect(again).toEqual({ companyId: acc.companyId, status: 'unchanged' });
    expect(await claimsOf(acc.uid)).toMatchObject({ companyId: acc.companyId });
    expect((await doc(`companies/${acc.companyId}`))?.name).toBe('Acme Ltd');
  });

  it.each(['PASSENGER', 'DRIVER'])('refuses a %s account', async (role) => {
    const acc = await account('create-consumer');
    await call(acc.client, 'completeRegistration', { role, name: 'Consumer' });
    await acc.user.getIdToken(true);
    await expect(
      call(acc.client, 'createCompany', { name: 'Acme', ownerName: 'X' }),
    ).rejects.toMatchObject(refused('failed-precondition', 'already has a role'));
    expect(await claimsOf(acc.uid)).toEqual({ role });
  });

  it('refuses a staff account, even one with no profile document', async () => {
    const acc = await account('create-staff');
    await admin().auth.setCustomUserClaims(acc.uid, { role: 'ADMIN' });
    await acc.user.getIdToken(true);
    await expect(
      call(acc.client, 'createCompany', { name: 'Acme', ownerName: 'X' }),
    ).rejects.toMatchObject(refused('failed-precondition', 'already has a role'));
  });

  it('refuses a member of a company who did not found it', async () => {
    const boss = await founder('create-boss');
    const worker = await joined(boss, 'create-worker');
    await expect(
      call(worker.client, 'createCompany', { name: 'My Own', ownerName: 'X' }),
    ).rejects.toMatchObject(refused('failed-precondition', 'already has a role'));
  });

  it('refuses an unverified email and invalid details', async () => {
    const unverified = await account('create-unverified', false);
    await expect(
      call(unverified.client, 'createCompany', { name: 'Acme', ownerName: 'X' }),
    ).rejects.toMatchObject(refused('permission-denied'));

    const acc = await account('create-invalid');
    for (const bad of [
      { name: 'A', ownerName: 'X' },
      { name: 'Acme', ownerName: '' },
      { name: 'x'.repeat(101), ownerName: 'X' },
      { ownerName: 'X' },
      null,
    ]) {
      await expect(call(acc.client, 'createCompany', bad)).rejects.toMatchObject(
        refused('invalid-argument'),
      );
    }
    expect((await doc(`users/${acc.uid}`)) ?? null).toBeNull();
  });

  it('stops at the platform-wide daily limit, and then at the per-account limit', async () => {
    // Called directly so the limit can be small, on a day no other test uses.
    const now = Date.UTC(2031, 5, 15, 12);
    const deps = {
      auth: admin().auth,
      firestore: firestore(),
      now: () => now,
      maxCompaniesPerDay: 1,
    };
    const caller = (acc: Account) => ({
      uid: acc.uid,
      role: undefined,
      emailVerified: true,
      companyId: undefined,
    });
    const input = { name: 'Limit Co', ownerName: 'X' };

    const first = await account('limit-first');
    await expect(createCompany(deps, caller(first), input)).resolves.toMatchObject({
      status: 'created',
    });

    const second = await account('limit-second');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(createCompany(deps, caller(second), input)).rejects.toMatchObject({
        code: 'resource-exhausted',
        message: expect.stringContaining('cannot be created right now') as unknown as string,
      });
    }
    // The fourth attempt in a day is stopped by the per-account limit before it gets that far.
    await expect(createCompany(deps, caller(second), input)).rejects.toMatchObject({
      code: 'resource-exhausted',
      message: expect.stringContaining('Too many requests') as unknown as string,
    });
    expect((await doc(`users/${second.uid}`)) ?? null).toBeNull();
  });

  it('cannot turn a company member into a consumer afterwards', async () => {
    const acc = await founder('create-then-consumer');
    await expect(
      call(acc.client, 'completeRegistration', { role: 'PASSENGER', name: 'Sneaky' }),
    ).rejects.toMatchObject(refused('failed-precondition'));
    expect((await doc(`users/${acc.uid}`))?.role).toBe('EMPLOYEE');
  });
});

describe('inviteEmployee', () => {
  it('creates an invitation, returns the code once, and stores only a hash', async () => {
    const boss = await founder('invite');
    const email = 'Colleague@Example.test';
    const issued = await invite(boss, email);
    expect(issued.code).toMatch(new RegExp(`^${issued.invitationId}\\.[A-Za-z0-9_-]{43}$`));
    expect(issued.expiresAt - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(issued.expiresAt - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);

    const stored = await doc(`companyInvitations/${issued.invitationId}`);
    expect(stored).toMatchObject({
      companyId: boss.companyId,
      email: 'colleague@example.test',
      companyRole: 'EMPLOYEE',
      status: 'PENDING',
      createdBy: boss.uid,
    });
    const token = issued.code.split('.')[1]!;
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(
      await auditOf(`companyInvitations/${issued.invitationId}`, 'EMPLOYEE_INVITED'),
    ).toHaveLength(1);
    for (const entry of await auditOf(
      `companyInvitations/${issued.invitationId}`,
      'EMPLOYEE_INVITED',
    )) {
      expect(JSON.stringify(entry.data())).not.toContain(token);
    }
  });

  it('is for company administrators only', async () => {
    const boss = await founder('invite-admin-only');
    const worker = await joined(boss, 'invite-worker');
    await expect(invite(worker as unknown as Founder, 'x@example.test')).rejects.toMatchObject(
      refused('permission-denied'),
    );

    const consumer = await account('invite-consumer');
    await call(consumer.client, 'completeRegistration', { role: 'PASSENGER', name: 'C' });
    await consumer.user.getIdToken(true);
    await expect(
      call(consumer.client, 'inviteEmployee', { email: 'x@example.test' }),
    ).rejects.toMatchObject(refused('permission-denied'));

    const unverified = await account('invite-unverified', false);
    await expect(
      call(unverified.client, 'inviteEmployee', { email: 'x@example.test' }),
    ).rejects.toMatchObject(refused('permission-denied'));
  });

  it('refuses a second pending invitation for the same email, until the first is revoked', async () => {
    const boss = await founder('invite-dup');
    const first = await invite(boss, 'dup@example.test');
    await expect(invite(boss, 'DUP@example.test')).rejects.toMatchObject(
      refused('failed-precondition', 'pending invitation'),
    );
    await result(boss.client, 'revokeInvitation', { invitationId: first.invitationId });
    await expect(invite(boss, 'dup@example.test')).resolves.toMatchObject({
      code: expect.any(String),
    });
  });

  it('closes an expired invitation for the email and issues a new one', async () => {
    const boss = await founder('invite-expired');
    const old = await invite(boss, 'again@example.test');
    await firestore()
      .doc(`companyInvitations/${old.invitationId}`)
      .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    const fresh = await invite(boss, 'again@example.test');
    expect(fresh.invitationId).not.toBe(old.invitationId);
    expect((await doc(`companyInvitations/${old.invitationId}`))?.status).toBe('EXPIRED');
  });

  it('refuses invalid emails and roles', async () => {
    const boss = await founder('invite-invalid');
    for (const bad of [
      { email: 'nope' },
      { email: '' },
      { email: 'a@b.co', companyRole: 'OWNER' },
      {},
    ]) {
      await expect(call(boss.client, 'inviteEmployee', bad)).rejects.toMatchObject(
        refused('invalid-argument'),
      );
    }
  });

  it('can invite another administrator', async () => {
    const boss = await founder('invite-admin-role');
    const issued = await invite(boss, 'second-admin@example.test', 'COMPANY_ADMIN');
    expect((await doc(`companyInvitations/${issued.invitationId}`))?.companyRole).toBe(
      'COMPANY_ADMIN',
    );
  });

  it('refuses someone who is already an active member of the company', async () => {
    const boss = await founder('invite-member');
    const worker = await joined(boss, 'invite-already');
    await expect(invite(boss, worker.email)).rejects.toMatchObject(
      refused('failed-precondition', 'already a member'),
    );
  });

  it('does not reveal whether an email already has an account', async () => {
    const boss = await founder('invite-leak');
    const consumer = await account('invite-leak-consumer');
    await call(consumer.client, 'completeRegistration', { role: 'DRIVER', name: 'C' });
    const forConsumer = await invite(boss, consumer.email);
    const forNobody = await invite(boss, 'nobody-at-all@example.test');
    expect(Object.keys(forConsumer).sort()).toEqual(Object.keys(forNobody).sort());
  });

  it('stops at the pending-invitation cap', async () => {
    const boss = await founder('invite-cap');
    const batch = firestore().batch();
    for (let i = 0; i < 200; i += 1) {
      batch.set(firestore().collection('companyInvitations').doc(), {
        companyId: boss.companyId,
        email: `seed-${i}@example.test`,
        tokenHash: 'x'.repeat(64),
        companyRole: 'EMPLOYEE',
        status: 'PENDING',
        expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000),
        createdBy: boss.uid,
        createdAt: Timestamp.now(),
      });
    }
    await batch.commit();
    await expect(invite(boss, 'one-too-many@example.test')).rejects.toMatchObject(
      refused('resource-exhausted', 'too many pending'),
    );
  });

  it('limits one administrator to 30 invitations an hour', async () => {
    const boss = await founder('invite-rate');
    for (let i = 0; i < 30; i += 1) await invite(boss, `rate-${i}@example.test`);
    await expect(invite(boss, 'rate-31@example.test')).rejects.toMatchObject(
      refused('resource-exhausted', 'Too many requests'),
    );
  });
});

describe('listInvitations and revokeInvitation', () => {
  it('lists the company invitations with their status, never the code or the hash', async () => {
    const boss = await founder('list-invites');
    const pending = await invite(boss, 'pending@example.test');
    const revoked = await invite(boss, 'revoked@example.test');
    await result(boss.client, 'revokeInvitation', { invitationId: revoked.invitationId });
    const expired = await invite(boss, 'expired@example.test');
    await firestore()
      .doc(`companyInvitations/${expired.invitationId}`)
      .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });

    const listed = await result<ListInvitationsResult>(boss.client, 'listInvitations');
    const byId = new Map(listed.rows.map((row) => [row.invitationId, row]));
    expect(byId.get(pending.invitationId)?.status).toBe('PENDING');
    expect(byId.get(revoked.invitationId)?.status).toBe('REVOKED');
    expect(byId.get(expired.invitationId)?.status).toBe('EXPIRED');
    const text = JSON.stringify(listed);
    expect(text).not.toContain(pending.code.split('.')[1]!);
    expect(text).not.toContain('tokenHash');
  });

  it("never shows another company's invitations", async () => {
    const a = await founder('list-a');
    const b = await founder('list-b');
    const mine = await invite(a, 'only-a@example.test');
    const listed = await result<ListInvitationsResult>(b.client, 'listInvitations');
    expect(listed.rows.map((row) => row.invitationId)).not.toContain(mine.invitationId);
    await expect(
      call(b.client, 'revokeInvitation', { invitationId: mine.invitationId }),
    ).rejects.toMatchObject(refused('not-found'));
    expect((await doc(`companyInvitations/${mine.invitationId}`))?.status).toBe('PENDING');
  });

  it('revokes once, repeats safely, and cannot revoke a used invitation', async () => {
    const boss = await founder('revoke');
    const issued = await invite(boss, 'revoke-me@example.test');
    expect(
      await result<RevokeInvitationResult>(boss.client, 'revokeInvitation', {
        invitationId: issued.invitationId,
      }),
    ).toEqual({ status: 'revoked' });
    expect(
      await result<RevokeInvitationResult>(boss.client, 'revokeInvitation', {
        invitationId: issued.invitationId,
      }),
    ).toEqual({ status: 'unchanged' });
    expect(
      await auditOf(`companyInvitations/${issued.invitationId}`, 'INVITATION_REVOKED'),
    ).toHaveLength(1);

    const used = await joined(boss, 'revoke-used');
    const usedInvitation = await firestore()
      .collection('companyInvitations')
      .where('acceptedBy', '==', used.uid)
      .get();
    await expect(
      call(boss.client, 'revokeInvitation', { invitationId: usedInvitation.docs[0]!.id }),
    ).rejects.toMatchObject(refused('failed-precondition', 'already been used'));
  });

  it('is for company administrators only', async () => {
    const boss = await founder('revoke-admin-only');
    const worker = await joined(boss, 'revoke-worker');
    await expect(call(worker.client, 'listInvitations')).rejects.toMatchObject(
      refused('permission-denied'),
    );
    await expect(
      call(worker.client, 'revokeInvitation', { invitationId: 'abc' }),
    ).rejects.toMatchObject(refused('permission-denied'));
  });
});

describe('acceptInvitation', () => {
  it('joins the company: profile, membership, invitation and claims, and audits it', async () => {
    const boss = await founder('accept');
    const acc = await account('accept-new');
    const issued = await invite(boss, acc.email);

    const accepted = await result<AcceptInvitationResult>(acc.client, 'acceptInvitation', {
      code: issued.code,
      name: ' New Person ',
      phone: '+449999',
    });
    expect(accepted).toEqual({
      companyId: boss.companyId,
      companyRole: 'EMPLOYEE',
      status: 'accepted',
    });

    expect(await doc(`users/${acc.uid}`)).toMatchObject({
      role: 'EMPLOYEE',
      name: 'New Person',
      email: acc.email.toLowerCase(),
      phone: '+449999',
      status: 'ACTIVE',
      companyId: boss.companyId,
    });
    expect(await doc(`companies/${boss.companyId}/members/${acc.uid}`)).toMatchObject({
      companyRole: 'EMPLOYEE',
      status: 'ACTIVE',
      canDrive: false,
    });
    expect(await doc(`companyInvitations/${issued.invitationId}`)).toMatchObject({
      status: 'ACCEPTED',
      acceptedBy: acc.uid,
    });
    expect(await claimsOf(acc.uid)).toEqual({
      role: 'EMPLOYEE',
      companyId: boss.companyId,
      companyRole: 'EMPLOYEE',
    });
    expect(
      await auditOf(`companyInvitations/${issued.invitationId}`, 'INVITATION_ACCEPTED'),
    ).toHaveLength(1);
  });

  it('gives the role the invitation names', async () => {
    const boss = await founder('accept-admin');
    const second = await joined(boss, 'accept-second-admin', 'COMPANY_ADMIN');
    expect(await claimsOf(second.uid)).toMatchObject({ companyRole: 'COMPANY_ADMIN' });
    // The new administrator can use administrator functions straight away.
    await expect(
      result<ListEmployeesResult>(second.client, 'listEmployees'),
    ).resolves.toMatchObject({ rows: expect.any(Array) });
  });

  it('is safe to repeat by the same person, and repairs missing claims', async () => {
    const boss = await founder('accept-repeat');
    const acc = await account('accept-repeat-new');
    const { code } = await invite(boss, acc.email);
    await call(acc.client, 'acceptInvitation', { code, name: 'Person' });
    await admin().auth.setCustomUserClaims(acc.uid, {});
    const again = await result<AcceptInvitationResult>(acc.client, 'acceptInvitation', {
      code,
      name: 'Person',
    });
    expect(again.status).toBe('unchanged');
    expect(await claimsOf(acc.uid)).toMatchObject({ companyId: boss.companyId });
  });

  it('gives every bad code the same answer', async () => {
    const boss = await founder('accept-bad');
    const acc = await account('accept-bad-new');
    const issued = await invite(boss, acc.email);
    const [id, token] = issued.code.split('.') as [string, string];
    const swapped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    const messages = new Set<string>();
    for (const code of [
      'garbage',
      `${id}.${swapped}`,
      `${'A'.repeat(20)}.${token}`,
      `${id}.${token}.extra`,
    ]) {
      const failure: unknown = await call(acc.client, 'acceptInvitation', { code, name: 'P' }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: 'functions/failed-precondition' });
      messages.add((failure as { message: string }).message);
    }
    expect([...messages]).toHaveLength(1);
    await expect(
      call(acc.client, 'acceptInvitation', { code: `${id}.${swapped}`, name: 'P' }),
    ).rejects.toMatchObject({ message: expect.stringContaining(INVALID) as unknown as string });
    expect((await doc(`companyInvitations/${id}`))?.status).toBe('PENDING');
    expect((await doc(`users/${acc.uid}`)) ?? null).toBeNull();
  });

  it('refuses a used, revoked, expired or suspended-company invitation with the same answer', async () => {
    const boss = await founder('accept-states');

    const used = await account('accept-used');
    const usedCode = (await invite(boss, used.email)).code;
    await call(used.client, 'acceptInvitation', { code: usedCode, name: 'P' });
    const thief = await account('accept-thief');
    await expect(
      call(thief.client, 'acceptInvitation', { code: usedCode, name: 'P' }),
    ).rejects.toMatchObject({ message: expect.stringContaining(INVALID) as unknown as string });

    const revoked = await account('accept-revoked');
    const issued = await invite(boss, revoked.email);
    await call(boss.client, 'revokeInvitation', { invitationId: issued.invitationId });
    await expect(
      call(revoked.client, 'acceptInvitation', { code: issued.code, name: 'P' }),
    ).rejects.toMatchObject({ message: expect.stringContaining(INVALID) as unknown as string });

    const late = await account('accept-late');
    const lateInvite = await invite(boss, late.email);
    await firestore()
      .doc(`companyInvitations/${lateInvite.invitationId}`)
      .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    await expect(
      call(late.client, 'acceptInvitation', { code: lateInvite.code, name: 'P' }),
    ).rejects.toMatchObject({ message: expect.stringContaining(INVALID) as unknown as string });

    const other = await founder('accept-suspended', 'Suspended Co');
    const sleeper = await account('accept-sleeper');
    const sleeperInvite = await invite(other, sleeper.email);
    await firestore().doc(`companies/${other.companyId}`).update({ status: 'SUSPENDED' });
    await expect(
      call(sleeper.client, 'acceptInvitation', { code: sleeperInvite.code, name: 'P' }),
    ).rejects.toMatchObject({ message: expect.stringContaining(INVALID) as unknown as string });
  });

  it('needs a verified email that matches the invitation', async () => {
    const boss = await founder('accept-email');
    const invited = await account('accept-invited');
    const { code } = await invite(boss, invited.email);

    const stranger = await account('accept-stranger');
    await expect(
      call(stranger.client, 'acceptInvitation', { code, name: 'P' }),
    ).rejects.toMatchObject(refused('failed-precondition', 'different email'));
    expect((await doc(`companyInvitations/${code.split('.')[0]}`))?.status).toBe('PENDING');

    const unverified = await account('accept-unverified', false);
    await expect(
      call(unverified.client, 'acceptInvitation', { code, name: 'P' }),
    ).rejects.toMatchObject(refused('permission-denied'));
  });

  it.each(['PASSENGER', 'DRIVER'])(
    'refuses an existing %s account, at accept time, and leaves it unchanged',
    async (role) => {
      const boss = await founder('accept-consumer-boss');
      const consumer = await account('accept-consumer');
      await call(consumer.client, 'completeRegistration', { role, name: 'Consumer' });
      await consumer.user.getIdToken(true);
      const { code, invitationId } = await invite(boss, consumer.email);

      await expect(
        call(consumer.client, 'acceptInvitation', { code, name: 'Consumer' }),
      ).rejects.toMatchObject(refused('failed-precondition', 'already has a role'));
      expect(await claimsOf(consumer.uid)).toEqual({ role });
      expect((await doc(`users/${consumer.uid}`))?.role).toBe(role);
      expect((await doc(`users/${consumer.uid}`))?.companyId).toBeUndefined();
      expect((await doc(`companyInvitations/${invitationId}`))?.status).toBe('PENDING');
    },
  );

  it('refuses a staff account and a member of another company', async () => {
    const boss = await founder('accept-other-boss');

    const staff = await account('accept-staff');
    await admin().auth.setCustomUserClaims(staff.uid, { role: 'SUPPORT' });
    await staff.user.getIdToken(true);
    const staffInvite = await invite(boss, staff.email);
    await expect(
      call(staff.client, 'acceptInvitation', { code: staffInvite.code, name: 'S' }),
    ).rejects.toMatchObject(refused('failed-precondition', 'already has a role'));
    // Refused before anything is written, not after: no profile, no membership, invitation still open.
    expect((await doc(`users/${staff.uid}`)) ?? null).toBeNull();
    expect((await doc(`companies/${boss.companyId}/members/${staff.uid}`)) ?? null).toBeNull();
    expect((await doc(`companyInvitations/${staffInvite.invitationId}`))?.status).toBe('PENDING');
    expect(await claimsOf(staff.uid)).toEqual({ role: 'SUPPORT' });

    const elsewhere = await founder('accept-elsewhere', 'Elsewhere Co');
    const crossInvite = await invite(boss, elsewhere.email);
    await expect(
      call(elsewhere.client, 'acceptInvitation', { code: crossInvite.code, name: 'E' }),
    ).rejects.toMatchObject(refused('failed-precondition'));
    expect(await claimsOf(elsewhere.uid)).toMatchObject({ companyId: elsewhere.companyId });
    expect((await doc(`companies/${boss.companyId}/members/${elsewhere.uid}`)) ?? null).toBeNull();
    expect((await doc(`companyInvitations/${crossInvite.invitationId}`))?.status).toBe('PENDING');
  });

  it('refuses invalid details', async () => {
    const boss = await founder('accept-details');
    const acc = await account('accept-details-new');
    const { code } = await invite(boss, acc.email);
    await expect(call(acc.client, 'acceptInvitation', { code, name: '' })).rejects.toMatchObject(
      refused('invalid-argument'),
    );
    await expect(call(acc.client, 'acceptInvitation', { name: 'P' })).rejects.toMatchObject(
      refused('invalid-argument'),
    );
  });

  it('limits guessing to 10 attempts an hour per account', async () => {
    const acc = await account('accept-guess');
    for (let i = 0; i < 10; i += 1) {
      await expect(
        call(acc.client, 'acceptInvitation', { code: 'nope', name: 'P' }),
      ).rejects.toMatchObject(refused('failed-precondition'));
    }
    await expect(
      call(acc.client, 'acceptInvitation', { code: 'nope', name: 'P' }),
    ).rejects.toMatchObject(refused('resource-exhausted'));
  });
});

describe('listEmployees', () => {
  it('lists the members with name, email, role and status, and pages through them', async () => {
    const boss = await founder('employees');
    const worker = await joined(boss, 'employees-worker');
    // Enough extra members to need a second page.
    const batch = firestore().batch();
    for (let i = 0; i < 52; i += 1) {
      batch.set(
        firestore().doc(`companies/${boss.companyId}/members/seed-${String(i).padStart(2, '0')}`),
        {
          companyRole: 'EMPLOYEE',
          status: i % 2 === 0 ? 'ACTIVE' : 'REMOVED',
          canDrive: false,
          joinedAt: Timestamp.now(),
        },
      );
    }
    await batch.commit();

    const rows = await allPages<ListEmployeesResult['rows'][number], string>(async (cursor) =>
      result<ListEmployeesResult>(boss.client, 'listEmployees', { cursor }),
    );
    expect(rows).toHaveLength(54);
    expect(new Set(rows.map((row) => row.uid)).size).toBe(54);

    const me = rows.find((row) => row.uid === boss.uid)!;
    expect(me).toMatchObject({
      companyRole: 'COMPANY_ADMIN',
      status: 'ACTIVE',
      name: 'Founder Person',
      email: boss.email.toLowerCase(),
    });
    expect(rows.find((row) => row.uid === worker.uid)).toMatchObject({
      companyRole: 'EMPLOYEE',
      name: 'New Person',
    });
    expect(rows.filter((row) => row.status === 'REMOVED')).toHaveLength(26);

    const first = await result<ListEmployeesResult>(boss.client, 'listEmployees', {});
    expect(first.rows).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
  });

  it('is for company administrators of that company only', async () => {
    const a = await founder('employees-a');
    const b = await founder('employees-b');
    const worker = await joined(a, 'employees-a-worker');
    await expect(call(worker.client, 'listEmployees', {})).rejects.toMatchObject(
      refused('permission-denied'),
    );
    const seenByB = await result<ListEmployeesResult>(b.client, 'listEmployees', {});
    expect(seenByB.rows.map((row) => row.uid)).toEqual([b.uid]);
  });
});

describe('removeEmployee', () => {
  it('removes a member: kept as REMOVED, profile suspended, claims cleared, tokens revoked', async () => {
    const boss = await founder('remove');
    const worker = await joined(boss, 'remove-worker');
    const before = (await admin().auth.getUser(worker.uid)).tokensValidAfterTime;

    expect(
      await result<RemoveEmployeeResult>(boss.client, 'removeEmployee', { uid: worker.uid }),
    ).toEqual({ status: 'removed' });

    expect(await doc(`companies/${boss.companyId}/members/${worker.uid}`)).toMatchObject({
      status: 'REMOVED',
      canDrive: false,
    });
    expect(await doc(`users/${worker.uid}`)).toMatchObject({
      status: 'SUSPENDED',
      statusReason: 'Removed from the company',
    });
    expect(await claimsOf(worker.uid)).toEqual({});
    const after = (await admin().auth.getUser(worker.uid)).tokensValidAfterTime;
    expect(new Date(after!).getTime()).toBeGreaterThanOrEqual(new Date(before!).getTime());
    expect(
      await auditOf(`companies/${boss.companyId}/members/${worker.uid}`, 'EMPLOYEE_REMOVED'),
    ).toHaveLength(1);
  });

  it('is safe to repeat', async () => {
    const boss = await founder('remove-repeat');
    const worker = await joined(boss, 'remove-repeat-worker');
    await call(boss.client, 'removeEmployee', { uid: worker.uid });
    expect(
      await result<RemoveEmployeeResult>(boss.client, 'removeEmployee', { uid: worker.uid }),
    ).toEqual({ status: 'unchanged' });
    expect(
      await auditOf(`companies/${boss.companyId}/members/${worker.uid}`, 'EMPLOYEE_REMOVED'),
    ).toHaveLength(1);
  });

  it('never removes the last administrator, but can once there is another', async () => {
    const boss = await founder('remove-last');
    await expect(call(boss.client, 'removeEmployee', { uid: boss.uid })).rejects.toMatchObject(
      refused('failed-precondition', 'at least one administrator'),
    );
    expect((await doc(`companies/${boss.companyId}/members/${boss.uid}`))?.status).toBe('ACTIVE');

    const second = await joined(boss, 'remove-second-admin', 'COMPANY_ADMIN');
    await expect(
      result<RemoveEmployeeResult>(boss.client, 'removeEmployee', { uid: boss.uid }),
    ).resolves.toEqual({ status: 'removed' });
    // The remaining administrator is now the last one.
    await expect(call(second.client, 'removeEmployee', { uid: second.uid })).rejects.toMatchObject(
      refused('failed-precondition', 'at least one administrator'),
    );
  });

  it('stops a removed administrator at once, even with a token that still names the company', async () => {
    const boss = await founder('remove-stale');
    const second = await joined(boss, 'remove-stale-admin', 'COMPANY_ADMIN');
    await call(boss.client, 'removeEmployee', { uid: second.uid });
    // second's token has not been refreshed, so it still carries the old claims.
    await expect(call(second.client, 'listEmployees', {})).rejects.toMatchObject(
      refused('permission-denied'),
    );
    await expect(
      call(second.client, 'inviteEmployee', { email: 'late@example.test' }),
    ).rejects.toMatchObject(refused('permission-denied'));
  });

  it("cannot reach another company's members, or ones that do not exist", async () => {
    const a = await founder('remove-a');
    const b = await founder('remove-b');
    const bWorker = await joined(b, 'remove-b-worker');
    await expect(call(a.client, 'removeEmployee', { uid: bWorker.uid })).rejects.toMatchObject(
      refused('not-found'),
    );
    await expect(call(a.client, 'removeEmployee', { uid: 'nobody' })).rejects.toMatchObject(
      refused('not-found'),
    );
    expect((await doc(`companies/${b.companyId}/members/${bWorker.uid}`))?.status).toBe('ACTIVE');
  });

  it('is for company administrators only', async () => {
    const boss = await founder('remove-admin-only');
    const worker = await joined(boss, 'remove-admin-only-worker');
    const other = await joined(boss, 'remove-admin-only-other');
    await expect(call(worker.client, 'removeEmployee', { uid: other.uid })).rejects.toMatchObject(
      refused('permission-denied'),
    );
  });

  it('lets a removed person be invited again, with no driving capability carried over', async () => {
    const boss = await founder('remove-return');
    const worker = await joined(boss, 'remove-return-worker');
    await firestore()
      .doc(`companies/${boss.companyId}/members/${worker.uid}`)
      .update({ canDrive: true });
    await call(boss.client, 'removeEmployee', { uid: worker.uid });

    const { code } = await invite(boss, worker.email);
    await signBackIn(worker);
    const back = await result<AcceptInvitationResult>(worker.client, 'acceptInvitation', {
      code,
      name: 'Returning Person',
    });
    expect(back.status).toBe('accepted');
    expect(await doc(`companies/${boss.companyId}/members/${worker.uid}`)).toMatchObject({
      status: 'ACTIVE',
      canDrive: false,
    });
    expect(await doc(`users/${worker.uid}`)).toMatchObject({
      status: 'ACTIVE',
      statusReason: null,
      name: 'Returning Person',
    });
    expect(await claimsOf(worker.uid)).toMatchObject({ companyId: boss.companyId });
  });

  it('does not let a person removed from one company rejoin through another', async () => {
    const a = await founder('remove-cross-a');
    const b = await founder('remove-cross-b', 'Other Co');
    const worker = await joined(a, 'remove-cross-worker');
    await call(a.client, 'removeEmployee', { uid: worker.uid });
    const { code } = await invite(b, worker.email);
    await signBackIn(worker);
    await expect(
      call(worker.client, 'acceptInvitation', { code, name: 'P' }),
    ).rejects.toMatchObject(refused('failed-precondition', 'already has a role'));
  });
});

describe('setEmployeeRole', () => {
  it('promotes and demotes within the company, updating the claims', async () => {
    const boss = await founder('role');
    const worker = await joined(boss, 'role-worker');

    expect(
      await result<SetEmployeeRoleResult>(boss.client, 'setEmployeeRole', {
        uid: worker.uid,
        companyRole: 'COMPANY_ADMIN',
      }),
    ).toEqual({ status: 'changed' });
    expect(await claimsOf(worker.uid)).toMatchObject({ companyRole: 'COMPANY_ADMIN' });
    expect((await doc(`companies/${boss.companyId}/members/${worker.uid}`))?.companyRole).toBe(
      'COMPANY_ADMIN',
    );
    expect(
      await auditOf(`companies/${boss.companyId}/members/${worker.uid}`, 'EMPLOYEE_ROLE_CHANGED'),
    ).toHaveLength(1);

    expect(
      await result<SetEmployeeRoleResult>(boss.client, 'setEmployeeRole', {
        uid: worker.uid,
        companyRole: 'COMPANY_ADMIN',
      }),
    ).toEqual({ status: 'unchanged' });

    await expect(
      result<SetEmployeeRoleResult>(boss.client, 'setEmployeeRole', {
        uid: worker.uid,
        companyRole: 'EMPLOYEE',
      }),
    ).resolves.toEqual({ status: 'changed' });
  });

  it('never demotes the last administrator', async () => {
    const boss = await founder('role-last');
    await expect(
      call(boss.client, 'setEmployeeRole', { uid: boss.uid, companyRole: 'EMPLOYEE' }),
    ).rejects.toMatchObject(refused('failed-precondition', 'at least one administrator'));
    expect((await doc(`companies/${boss.companyId}/members/${boss.uid}`))?.companyRole).toBe(
      'COMPANY_ADMIN',
    );
  });

  it('refuses removed or unknown members, other companies, and non-administrators', async () => {
    const a = await founder('role-a');
    const b = await founder('role-b');
    const worker = await joined(a, 'role-a-worker');
    const gone = await joined(a, 'role-a-gone');
    await call(a.client, 'removeEmployee', { uid: gone.uid });

    for (const uid of [gone.uid, 'nobody', b.uid]) {
      await expect(
        call(a.client, 'setEmployeeRole', { uid, companyRole: 'COMPANY_ADMIN' }),
      ).rejects.toMatchObject(refused('not-found'));
    }
    await expect(
      call(worker.client, 'setEmployeeRole', { uid: worker.uid, companyRole: 'COMPANY_ADMIN' }),
    ).rejects.toMatchObject(refused('permission-denied'));
    expect((await doc(`companies/${a.companyId}/members/${worker.uid}`))?.companyRole).toBe(
      'EMPLOYEE',
    );
    await expect(
      call(a.client, 'setEmployeeRole', { uid: worker.uid, companyRole: 'OWNER' }),
    ).rejects.toMatchObject(refused('invalid-argument'));
  });
});
