import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import type { CompanyOverview, UpdateCompanySettingsResult } from '../../packages/tenancy/src';
import { readDeclineWindowMs } from '../../functions/src/declineWindow';
import { admin } from './support';
import {
  account,
  auditOf,
  call,
  doc,
  firestore,
  founder,
  invite,
  joined,
  refused,
  result,
  type Founder,
} from './company-support';

// Module A4a: the two functions the company dashboard adds (functions + firestore + auth
// emulators). See docs/a4-company-dashboard-design.md.

let plateCounter = 0;
const vehicle = () => ({
  type: 'CAR',
  make: 'Toyota',
  model: 'Corolla',
  plateNumber: `DASH-${Date.now() % 100000}-${plateCounter++}`,
});

const settings = (boss: Founder, input: unknown) =>
  result<UpdateCompanySettingsResult>(boss.client, 'updateCompanySettings', input);
const overview = (who: { client: Founder['client'] }) =>
  result<CompanyOverview>(who.client, 'getCompanyOverview');
const companyDoc = (boss: Founder) => doc(`companies/${boss.companyId}`);
const settingsAudits = (boss: Founder) =>
  auditOf(`companies/${boss.companyId}`, 'COMPANY_SETTINGS_CHANGED');

describe('updateCompanySettings', () => {
  it('changes the name and the window, and audits what changed', async () => {
    const boss = await founder('set-both', 'Before Ltd');
    expect(await settings(boss, { name: '  After Ltd  ', driverDeclineWindowMinutes: 12 })).toEqual({
      status: 'updated',
      name: 'After Ltd',
      driverDeclineWindowMinutes: 12,
    });
    expect(await companyDoc(boss)).toMatchObject({
      name: 'After Ltd',
      settings: { driverDeclineWindowMinutes: 12 },
    });

    const audits = await settingsAudits(boss);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.data()).toMatchObject({
      actor: boss.uid,
      previousState: { name: 'Before Ltd', driverDeclineWindowMinutes: 5 },
      newState: { name: 'After Ltd', driverDeclineWindowMinutes: 12 },
    });
  });

  it('changes one setting without touching the other', async () => {
    const boss = await founder('set-one', 'Keep Ltd');
    await settings(boss, { driverDeclineWindowMinutes: 0 });
    expect(await companyDoc(boss)).toMatchObject({
      name: 'Keep Ltd',
      settings: { driverDeclineWindowMinutes: 0 },
    });

    await settings(boss, { name: 'Renamed Ltd' });
    expect(await companyDoc(boss)).toMatchObject({
      name: 'Renamed Ltd',
      settings: { driverDeclineWindowMinutes: 0 },
    });
    // Only the changed field is in each audit entry.
    const states = (await settingsAudits(boss)).map((entry) => entry.data().newState);
    expect(states).toContainEqual({ driverDeclineWindowMinutes: 0 });
    expect(states).toContainEqual({ name: 'Renamed Ltd' });
  });

  it('answers "unchanged" and writes nothing when nothing differs', async () => {
    const boss = await founder('set-same', 'Same Ltd');
    await settings(boss, { driverDeclineWindowMinutes: 9 });
    const before = await companyDoc(boss);

    expect(await settings(boss, { name: 'Same Ltd', driverDeclineWindowMinutes: 9 })).toEqual({
      status: 'unchanged',
      name: 'Same Ltd',
      driverDeclineWindowMinutes: 9,
    });
    expect(await companyDoc(boss)).toEqual(before);
    expect(await settingsAudits(boss)).toHaveLength(1);
  });

  it('treats the default as the current window when none was ever chosen', async () => {
    const boss = await founder('set-default');
    expect(await settings(boss, { driverDeclineWindowMinutes: 5 })).toMatchObject({
      status: 'unchanged',
      driverDeclineWindowMinutes: 5,
    });
    expect((await companyDoc(boss))?.settings).toBeUndefined();
  });

  it('accepts the null the Firebase client sends for a field left out', async () => {
    const boss = await founder('set-null');
    expect(await settings(boss, { name: null, driverDeclineWindowMinutes: 20 })).toMatchObject({
      status: 'updated',
      driverDeclineWindowMinutes: 20,
    });
    expect(await settings(boss, { name: 'Null Ltd', driverDeclineWindowMinutes: null })).toMatchObject({
      status: 'updated',
      name: 'Null Ltd',
      driverDeclineWindowMinutes: 20,
    });
  });

  it('is the window the matching code then uses (module A3b)', async () => {
    const boss = await founder('set-used');
    await settings(boss, { driverDeclineWindowMinutes: 17 });
    expect(await readDeclineWindowMs(firestore(), boss.companyId)).toBe(17 * 60_000);
    await settings(boss, { driverDeclineWindowMinutes: 0 });
    expect(await readDeclineWindowMs(firestore(), boss.companyId)).toBe(0);
  });

  it.each([
    ['nothing at all', {}],
    ['both fields empty', { name: null, driverDeclineWindowMinutes: null }],
    ['a one-letter name', { name: 'A' }],
    ['a name that is only spaces', { name: '   ' }],
    ['a name of 101 characters', { name: 'x'.repeat(101) }],
    ['a window of 31', { driverDeclineWindowMinutes: 31 }],
    ['a negative window', { driverDeclineWindowMinutes: -1 }],
    ['a fractional window', { driverDeclineWindowMinutes: 2.5 }],
    ['a window sent as text', { driverDeclineWindowMinutes: '5' }],
    ['a good name with a bad window', { name: 'Fine Ltd', driverDeclineWindowMinutes: 99 }],
  ])('refuses %s and writes nothing', async (_label, input) => {
    const boss = await founder('set-invalid', 'Stays Ltd');
    await expect(call(boss.client, 'updateCompanySettings', input)).rejects.toMatchObject(
      refused('invalid-argument'),
    );
    expect(await companyDoc(boss)).toMatchObject({ name: 'Stays Ltd' });
    expect((await companyDoc(boss))?.settings).toBeUndefined();
    expect(await settingsAudits(boss)).toHaveLength(0);
  });

  it('is for administrators only', async () => {
    const boss = await founder('set-who', 'Locked Ltd');
    const worker = await joined(boss, 'set-who-worker');
    const outsider = await account('set-who-outsider');

    for (const caller of [worker, outsider]) {
      await expect(
        call(caller.client, 'updateCompanySettings', { name: 'Hijacked' }),
      ).rejects.toMatchObject(refused('permission-denied'));
    }
    const unverified = await account('set-who-unverified', false);
    await expect(
      call(unverified.client, 'updateCompanySettings', { name: 'Hijacked' }),
    ).rejects.toMatchObject(refused('permission-denied'));

    expect(await companyDoc(boss)).toMatchObject({ name: 'Locked Ltd' });
    expect(await settingsAudits(boss)).toHaveLength(0);
  });

  it("only ever changes the caller's own company", async () => {
    const a = await founder('set-a', 'A Ltd');
    const b = await founder('set-b', 'B Ltd');
    await settings(a, { name: 'A Renamed', driverDeclineWindowMinutes: 3 });
    expect(await companyDoc(b)).toMatchObject({ name: 'B Ltd' });
    expect((await companyDoc(b))?.settings).toBeUndefined();
  });

  it('refuses an administrator who was demoted, even while their token still says administrator', async () => {
    const boss = await founder('set-demoted', 'Demote Ltd');
    const second = await joined(boss, 'set-demoted-second', 'COMPANY_ADMIN');
    await call(boss.client, 'setEmployeeRole', { uid: second.uid, companyRole: 'EMPLOYEE' });

    // second's token (not refreshed) still carries COMPANY_ADMIN.
    await expect(
      call(second.client, 'updateCompanySettings', { name: 'Stale Token Ltd' }),
    ).rejects.toMatchObject(refused('permission-denied'));
    expect(await companyDoc(boss)).toMatchObject({ name: 'Demote Ltd' });
  });

  it('limits how often one administrator can change settings', async () => {
    const boss = await founder('set-limit');
    for (let call_ = 0; call_ < 30; call_++) {
      await settings(boss, { driverDeclineWindowMinutes: call_ % 31 });
    }
    await expect(settings(boss, { driverDeclineWindowMinutes: 1 })).rejects.toMatchObject(
      refused('resource-exhausted'),
    );
  });
});

describe('getCompanyOverview', () => {
  it('starts a new company at one employee and nothing else', async () => {
    const boss = await founder('ov-new', 'Fresh Ltd');
    expect(await overview(boss)).toEqual({
      companyName: 'Fresh Ltd',
      employees: 1,
      pendingInvitations: 0,
      driverApplications: 0,
      approvedDrivers: 0,
    });
  });

  it('counts employees, pending invitations, applications and approved drivers', async () => {
    const boss = await founder('ov-counts');
    const one = await joined(boss, 'ov-counts-one');
    const two = await joined(boss, 'ov-counts-two');
    await invite(boss, `ov-counts-p1-${Date.now()}@example.test`);
    await invite(boss, `ov-counts-p2-${Date.now()}@example.test`);

    for (const person of [one, two]) {
      await call(person.client, 'applyToDrive');
      await call(person.client, 'saveEmployeeVehicle', vehicle());
    }
    expect(await overview(boss)).toMatchObject({
      employees: 3,
      pendingInvitations: 2,
      driverApplications: 2,
      approvedDrivers: 0,
    });

    await call(boss.client, 'approveEmployeeDriver', { uid: one.uid });
    expect(await overview(boss)).toMatchObject({ driverApplications: 1, approvedDrivers: 1 });

    await call(boss.client, 'removeEmployee', { uid: one.uid });
    expect(await overview(boss)).toMatchObject({
      employees: 2,
      driverApplications: 1,
      approvedDrivers: 0,
    });
  });

  it('does not count accepted, revoked or expired invitations as pending', async () => {
    const boss = await founder('ov-invites');
    const accepted = await account('ov-invites-accepted');
    const { code } = await invite(boss, accepted.email);
    await call(accepted.client, 'acceptInvitation', { code, name: 'Accepted Person' });

    const revoked = await invite(boss, `ov-invites-revoked-${Date.now()}@example.test`);
    await call(boss.client, 'revokeInvitation', { invitationId: revoked.invitationId });

    const expired = await invite(boss, `ov-invites-expired-${Date.now()}@example.test`);
    await firestore()
      .doc(`companyInvitations/${expired.invitationId}`)
      .update({ expiresAt: Timestamp.fromMillis(Date.now() - 60_000) });

    const live = await invite(boss, `ov-invites-live-${Date.now()}@example.test`);
    expect(live.invitationId).toBeTruthy();

    expect(await overview(boss)).toMatchObject({ employees: 2, pendingInvitations: 1 });
  });

  it("never counts another company's people, invitations or applications", async () => {
    const a = await founder('ov-iso-a', 'A Ltd');
    const b = await founder('ov-iso-b', 'B Ltd');
    const bWorker = await joined(b, 'ov-iso-b-worker');
    await call(bWorker.client, 'applyToDrive');
    await invite(b, `ov-iso-b-${Date.now()}@example.test`);

    expect(await overview(a)).toEqual({
      companyName: 'A Ltd',
      employees: 1,
      pendingInvitations: 0,
      driverApplications: 0,
      approvedDrivers: 0,
    });
    expect(await overview(b)).toMatchObject({
      employees: 2,
      pendingInvitations: 1,
      driverApplications: 1,
    });
  });

  it('follows a changed company name', async () => {
    const boss = await founder('ov-name', 'Old Name');
    await settings(boss, { name: 'New Name' });
    expect((await overview(boss)).companyName).toBe('New Name');
  });

  it('is for administrators only, and shows no trip or place', async () => {
    const boss = await founder('ov-who');
    const worker = await joined(boss, 'ov-who-worker');
    const outsider = await account('ov-who-outsider');
    for (const caller of [worker, outsider]) {
      await expect(call(caller.client, 'getCompanyOverview')).rejects.toMatchObject(
        refused('permission-denied'),
      );
    }
    expect(Object.keys(await overview(boss)).sort()).toEqual([
      'approvedDrivers',
      'companyName',
      'driverApplications',
      'employees',
      'pendingInvitations',
    ]);
  });

  it('is refused for a suspended company', async () => {
    const boss = await founder('ov-suspended');
    await firestore().doc(`companies/${boss.companyId}`).update({ status: 'SUSPENDED' });
    await expect(call(boss.client, 'getCompanyOverview')).rejects.toMatchObject(
      refused('permission-denied'),
    );
    await expect(
      call(boss.client, 'updateCompanySettings', { name: 'Still Suspended' }),
    ).rejects.toMatchObject(refused('permission-denied'));
  });
});

// A consumer account must stay unable to reach either function.
describe('consumers', () => {
  it('cannot call either function', async () => {
    const consumer = await account('dash-consumer');
    await admin().firestore.doc(`users/${consumer.uid}`).set({ role: 'PASSENGER' });
    await admin().auth.setCustomUserClaims(consumer.uid, { role: 'PASSENGER' });
    await consumer.user.getIdToken(true);
    for (const name of ['getCompanyOverview', 'updateCompanySettings']) {
      await expect(
        call(consumer.client, name, name === 'updateCompanySettings' ? { name: 'No' } : undefined),
      ).rejects.toMatchObject(refused('permission-denied'));
    }
  });
});
