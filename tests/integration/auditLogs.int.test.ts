import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { listAuditLogs } from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail } from './support';

// Module 11.8 (admin dashboard: audit logs). listAuditLogs (functions/src/auditLogs.ts) is new.
// Entries are seeded here with a direct admin write, in the shape the real modules write them - what
// is under test is this module's own read, filter, paging and hiding logic, not how each module
// writes its entry (each has its own tests). The Firestore here is shared and long-lived across the
// whole run, so every test scopes itself with an action name no other test or module uses.

const uniqueAction = () =>
  `TEST_AUDIT_${Array.from({ length: 10 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')}`;

async function account(prefix: string, role?: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  if (role) await admin().auth.setCustomUserClaims(uid, { role });
  await verifyEmail(user, email);
  return { client, uid, email };
}

async function seed(entry: {
  action: string;
  actor?: string;
  entity?: string;
  previousState?: unknown;
  newState?: unknown;
  reason?: string | null;
  timestamp?: Timestamp;
}) {
  const ref = admin().firestore.collection('auditLogs').doc();
  await ref.set({
    timestamp: entry.timestamp ?? Timestamp.now(),
    actor: entry.actor ?? 'system',
    action: entry.action,
    entity: entry.entity ?? 'tests/entity',
    previousState: entry.previousState ?? null,
    newState: entry.newState ?? null,
    reason: entry.reason === undefined ? 'seeded' : entry.reason,
  });
  return ref.id;
}

describe('listAuditLogs (functions + firestore + auth emulators)', () => {
  it('lists ADMIN and SUPER_ADMIN staff the log, and refuses everyone else', async () => {
    const action = uniqueAction();
    await seed({ action });

    for (const role of ['ADMIN', 'SUPER_ADMIN']) {
      const caller = await account(`audit-allowed-${role.toLowerCase()}`, role);
      const result = await listAuditLogs(caller.client, { action });
      expect(result.rows).toHaveLength(1);
    }

    for (const role of ['SUPPORT', 'OPERATIONS']) {
      const caller = await account(`audit-refused-${role.toLowerCase()}`, role);
      await expect(listAuditLogs(caller.client, { action })).rejects.toMatchObject({
        message: 'You are not allowed to view the audit log.',
      });
    }
    const passenger = await account('audit-refused-passenger');
    await expect(listAuditLogs(passenger.client, { action })).rejects.toMatchObject({
      message: 'You are not allowed to view the audit log.',
    });
    await expect(listAuditLogs(createClient(), { action })).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });
  });

  it('refuses a staff account whose email is not verified', async () => {
    const client = createClient();
    const { uid } = await signUp(client, 'audit-unverified');
    await admin().auth.setCustomUserClaims(uid, { role: 'ADMIN' });
    await client.auth.currentUser?.getIdToken(true);
    await expect(listAuditLogs(client, {})).rejects.toMatchObject({
      message: 'You are not allowed to view the audit log.',
    });
  });

  it('is not readable through Firestore directly, even by staff', async () => {
    const reviewer = await account('audit-direct-read', 'ADMIN');
    const { collection, getDocs } = await import('firebase/firestore');
    await expect(getDocs(collection(reviewer.client.firestore, 'auditLogs'))).rejects.toMatchObject(
      { code: 'permission-denied' },
    );
  });

  it('lists newest first, with the stored fields, and no reconstructed place', async () => {
    const reviewer = await account('audit-order', 'ADMIN');
    const action = uniqueAction();
    const base = Date.now();
    await seed({
      action,
      entity: 'tripRequests/older',
      timestamp: Timestamp.fromMillis(base - 5000),
      reason: null,
    });
    await seed({
      action,
      entity: 'tripRequests/newer',
      timestamp: Timestamp.fromMillis(base),
      previousState: { status: 'SEARCHING' },
      newState: { status: 'PICKUP_ASSIGNED', when: Timestamp.fromMillis(base) },
      reason: 'Matched',
    });

    const { rows, nextCursor } = await listAuditLogs(reviewer.client, { action });
    expect(rows.map((r) => r.entity)).toEqual(['tripRequests/newer', 'tripRequests/older']);
    expect(nextCursor).toBeNull();
    expect(rows[0]).toMatchObject({
      action,
      actor: 'system',
      actorName: null,
      actorEmail: null,
      reason: 'Matched',
      previousState: { status: 'SEARCHING' },
      newState: { status: 'PICKUP_ASSIGNED', when: new Date(base).toISOString() },
      changedFields: null,
    });
    expect(rows[0]?.timestamp).toBe(base);
    expect(rows[1]?.reason).toBeNull();
    expect(rows[0]).not.toHaveProperty('origin');
    expect(rows[0]).not.toHaveProperty('formattedAddress');
  });

  it('filters by exact action', async () => {
    const reviewer = await account('audit-filter-action', 'ADMIN');
    const wanted = uniqueAction();
    const other = uniqueAction();
    await seed({ action: wanted, entity: 'tests/wanted' });
    await seed({ action: other, entity: 'tests/other' });

    const { rows } = await listAuditLogs(reviewer.client, { action: wanted });
    expect(rows.map((r) => r.entity)).toEqual(['tests/wanted']);
  });

  it('filters by actor: uid, email, system and script are matched, an unknown email finds nothing', async () => {
    const reviewer = await account('audit-filter-actor', 'ADMIN');
    const target = await account('audit-filter-target');
    await admin()
      .firestore.doc(`users/${target.uid}`)
      .set({ name: 'Target Person', email: target.email });
    const action = uniqueAction();
    await seed({ action, actor: target.uid, entity: 'tests/by-target' });
    await seed({ action, actor: 'system', entity: 'tests/by-system' });
    await seed({ action, actor: 'script:set-staff-role', entity: 'tests/by-script' });

    const entities = async (actor: string) =>
      (await listAuditLogs(reviewer.client, { action, actor })).rows.map((r) => r.entity);

    expect(await entities(target.uid)).toEqual(['tests/by-target']);
    expect(await entities(target.email)).toEqual(['tests/by-target']);
    expect(await entities(target.email.toUpperCase())).toEqual(['tests/by-target']);
    expect(await entities('system')).toEqual(['tests/by-system']);
    expect(await entities('script:set-staff-role')).toEqual(['tests/by-script']);
    expect(await entities('nobody-at-all@example.com')).toEqual([]);
  });

  it('shows an account actor by name and email, and system/script actors as stored', async () => {
    const reviewer = await account('audit-resolve', 'ADMIN');
    const target = await account('audit-resolve-target');
    await admin()
      .firestore.doc(`users/${target.uid}`)
      .set({ name: 'Resolved Person', email: target.email });
    const action = uniqueAction();
    await seed({ action, actor: target.uid, entity: 'tests/account' });
    await seed({ action, actor: 'script:backfill-driver-profiles', entity: 'tests/script' });
    await seed({ action, actor: 'uid-of-a-deleted-account', entity: 'tests/deleted' });

    const { rows } = await listAuditLogs(reviewer.client, { action });
    const by = (entity: string) => rows.find((r) => r.entity === entity);
    expect(by('tests/account')).toMatchObject({
      actor: target.uid,
      actorName: 'Resolved Person',
      actorEmail: target.email,
    });
    expect(by('tests/script')).toMatchObject({
      actor: 'script:backfill-driver-profiles',
      actorName: null,
      actorEmail: null,
    });
    expect(by('tests/deleted')).toMatchObject({
      actor: 'uid-of-a-deleted-account',
      actorName: null,
      actorEmail: null,
    });
  });

  it('pages newest first without skipping or repeating an entry, even within one second', async () => {
    const reviewer = await account('audit-paging', 'ADMIN');
    const action = uniqueAction();
    const seconds = Math.floor(Date.now() / 1000);
    // 30 entries inside the SAME second, 1ms apart to 1 microsecond apart mixed: a cursor cut to
    // milliseconds would lose entries here.
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      ids.push(
        await seed({
          action,
          entity: `tests/paged-${String(i).padStart(2, '0')}`,
          timestamp: new Timestamp(seconds, 100_000_000 + i * 1000),
        }),
      );
    }

    const first = await listAuditLogs(reviewer.client, { action });
    expect(first.rows).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    const second = await listAuditLogs(reviewer.client, { action, cursor: first.nextCursor });
    expect(second.rows).toHaveLength(5);
    expect(second.nextCursor).toBeNull();

    const listed = [...first.rows, ...second.rows].map((r) => r.logId);
    expect(new Set(listed).size).toBe(30);
    expect(listed).toEqual([...ids].reverse());
  });

  it('shows only which fields changed for a vehicle entry, never a value such as the plate', async () => {
    const reviewer = await account('audit-vehicle', 'ADMIN');
    const created = uniqueAction();
    // The real entries use these two actions; scope to them by entity instead of a unique action.
    const entity = `vehicles/${created}`;
    const details = {
      vehicleType: 'SEDAN',
      make: 'Toyota',
      model: 'Corolla',
      plateNumber: 'AB12 CDE',
      plateKey: 'AB12CDE',
      seatCapacity: 4,
    };
    await seed({
      action: 'VEHICLE_CREATED',
      actor: 'system',
      entity,
      previousState: null,
      newState: { ...details, verificationStatus: 'PENDING' },
    });
    await seed({
      action: 'VEHICLE_UPDATED',
      actor: 'system',
      entity,
      previousState: { ...details, verificationStatus: 'VERIFIED' },
      newState: {
        ...details,
        plateNumber: 'ZZ99 ZZZ',
        plateKey: 'ZZ99ZZZ',
        verificationStatus: 'PENDING',
      },
      reason: 'Driver changed their vehicle details',
    });

    const all = (
      await Promise.all(
        ['VEHICLE_CREATED', 'VEHICLE_UPDATED'].map((action) =>
          listAuditLogs(reviewer.client, { action, actor: 'system' }),
        ),
      )
    ).flatMap((result) => result.rows.filter((r) => r.entity === entity));
    expect(all).toHaveLength(2);

    const createdRow = all.find((r) => r.action === 'VEHICLE_CREATED');
    expect(createdRow?.changedFields).toEqual([
      'make',
      'model',
      'plateKey',
      'plateNumber',
      'seatCapacity',
      'vehicleType',
      'verificationStatus',
    ]);
    const updatedRow = all.find((r) => r.action === 'VEHICLE_UPDATED');
    expect(updatedRow?.changedFields).toEqual(['plateKey', 'plateNumber', 'verificationStatus']);
    expect(updatedRow?.reason).toBe('Driver changed their vehicle details');

    for (const row of all) {
      expect(row.previousState).toBeNull();
      expect(row.newState).toBeNull();
      const serialized = JSON.stringify(row);
      for (const secret of ['AB12', 'ZZ99', 'Toyota', 'Corolla']) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  it('leaves the stored vehicle entry untouched, and does not audit a list load', async () => {
    const reviewer = await account('audit-untouched', 'ADMIN');
    const action = 'VEHICLE_UPDATED';
    const entity = `vehicles/${uniqueAction()}`;
    const id = await seed({
      action,
      actor: 'system',
      entity,
      previousState: { plateNumber: 'KEEP 123' },
      newState: { plateNumber: 'KEEP 456' },
    });
    const before = await admin().firestore.collection('auditLogs').doc(id).get();

    await listAuditLogs(reviewer.client, { action, actor: 'system' });

    const after = await admin().firestore.collection('auditLogs').doc(id).get();
    expect(after.data()).toEqual(before.data());
    expect(after.get('newState')).toEqual({ plateNumber: 'KEEP 456' });

    const byReviewer = await admin()
      .firestore.collection('auditLogs')
      .where('actor', '==', reviewer.uid)
      .get();
    expect(byReviewer.empty).toBe(true);
  });

  it('refuses a malformed request', async () => {
    const reviewer = await account('audit-malformed', 'ADMIN');
    for (const bad of [
      { action: 'lower_case' },
      { actor: '' },
      { cursor: { seconds: 1, nanoseconds: -5, logId: 'x' } },
      { cursor: { seconds: 1, nanoseconds: 0, logId: '' } },
    ]) {
      await expect(listAuditLogs(reviewer.client, bad)).rejects.toMatchObject({
        code: 'functions/invalid-argument',
      });
    }
  });
});
