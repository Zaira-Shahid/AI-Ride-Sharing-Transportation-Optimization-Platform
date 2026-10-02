import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import { listDriversForReview, saveVehicle, submitStaffReview } from '../../packages/firebase/src';
import { admin, allPages, createClient, signUp, verifyEmail, type Client } from './support';
import type { StatusCursor } from '../../packages/firebase/src';

// Module 11.2 (admin dashboard: driver/vehicle management): adminReview.ts's own client wrapper
// (listDriversForReview, submitStaffReview) tested directly against the real emulators - the same
// "call the function directly" approach staffSignIn.int.test.ts already took for signInStaff.
// reviewDriver/reviewVehicle's own backend logic is already fully covered by verification.int.test.ts;
// this file only exercises the NEW client-side pieces (the combined driver+vehicle read, and the
// permission-denied -> AuthFlowError translation) - not every reviewDriver/reviewVehicle behavior again.

let plateCounter = 0;
const uniquePlate = () => `ADM-${Date.now() % 100000}-${plateCounter++}`;

async function person(role: 'DRIVER' | 'PASSENGER', prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
  await verifyEmail(user, email);
  return { client, uid, email };
}

async function staff(role: string, prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await admin().auth.setCustomUserClaims(uid, { role });
  await verifyEmail(user, email);
  return { client, uid, email };
}

async function driver(prefix: string, withVehicle = true) {
  const person_ = await person('DRIVER', prefix);
  if (withVehicle) {
    await saveVehicle(person_.client, {
      type: 'CAR',
      make: 'Toyota',
      model: 'Corolla',
      plateNumber: uniquePlate(),
    });
  }
  return person_;
}

const call = (client: Client, name: string, data: unknown) =>
  httpsCallable(client.functions, name)(data);

describe('listDriversForReview (functions + firestore + auth emulators)', () => {
  it('lists a driver with their vehicle, pending ones first', async () => {
    const reviewer = await staff('ADMIN', 'admrev-reviewer');
    const pending = await driver('admrev-pending');
    const verified = await driver('admrev-verified');
    await call(reviewer.client, 'reviewDriver', { driverId: verified.uid, decision: 'VERIFIED' });

    const rows = await allPages((cursor: StatusCursor | null) =>
      listDriversForReview(reviewer.client, { cursor }),
    );
    const pendingRow = rows.find((row) => row.uid === pending.uid);
    const verifiedRow = rows.find((row) => row.uid === verified.uid);

    expect(pendingRow).toMatchObject({
      email: pending.email,
      driverVerificationStatus: 'PENDING',
      vehicle: { make: 'Toyota', model: 'Corolla', type: 'CAR' },
    });
    expect(verifiedRow).toMatchObject({ driverVerificationStatus: 'VERIFIED' });
    expect(rows.indexOf(pendingRow!)).toBeLessThan(rows.indexOf(verifiedRow!));
  });

  it('reports a driver with no saved vehicle as vehicle: null', async () => {
    const reviewer = await staff('ADMIN', 'admrev-noveh-reviewer');
    const target = await driver('admrev-noveh', false);

    const rows = await allPages((cursor: StatusCursor | null) =>
      listDriversForReview(reviewer.client, { cursor }),
    );
    expect(rows.find((row) => row.uid === target.uid)).toMatchObject({ vehicle: null });
  });
});

describe('submitStaffReview', () => {
  it('verifies a driver and a vehicle', async () => {
    const reviewer = await staff('ADMIN', 'admrev-submit-reviewer');
    const target = await driver('admrev-submit-target');

    expect(await submitStaffReview(reviewer.client, 'DRIVER', target.uid, 'VERIFIED', null)).toBe(
      'reviewed',
    );
    expect(await submitStaffReview(reviewer.client, 'VEHICLE', target.uid, 'VERIFIED', null)).toBe(
      'reviewed',
    );

    const rows = await allPages((cursor: StatusCursor | null) =>
      listDriversForReview(reviewer.client, { cursor }),
    );
    const row = rows.find((r) => r.uid === target.uid);
    expect(row?.driverVerificationStatus).toBe('VERIFIED');
    expect(row?.vehicle?.verificationStatus).toBe('VERIFIED');
  });

  it('rejects with a reason that shows up on the next read', async () => {
    const reviewer = await staff('ADMIN', 'admrev-reject-reviewer');
    const target = await driver('admrev-reject-target');

    await submitStaffReview(reviewer.client, 'DRIVER', target.uid, 'REJECTED', 'Bad photo.');
    const rows = await allPages((cursor: StatusCursor | null) =>
      listDriversForReview(reviewer.client, { cursor }),
    );
    expect(rows.find((r) => r.uid === target.uid)).toMatchObject({
      driverVerificationStatus: 'REJECTED',
      driverVerificationReason: 'Bad photo.',
    });
  });

  it('turns a permission-denied refusal into a clear message, for a non-reviewer staff role', async () => {
    const support = await staff('SUPPORT', 'admrev-support');
    const target = await driver('admrev-support-target');

    await expect(
      submitStaffReview(support.client, 'DRIVER', target.uid, 'VERIFIED', null),
    ).rejects.toMatchObject({ message: 'You are not allowed to review drivers.' });
  });
});

// Phase 14 (performance): a page of drivers, not every driver. The emulator is shared with every other
// spec, so these seed their own drivers and look for them across the pages.
describe('listDriversForReview paging', () => {
  const STATUS_RANK: Record<string, number> = { PENDING: 0, REJECTED: 1, VERIFIED: 2 };

  async function seedDrivers(prefix: string, statuses: string[]) {
    const stamp = Date.now();
    const uids = statuses.map((_, index) => `${prefix}-${stamp}-${index}`);
    const now = new Date();
    for (const [index, uid] of uids.entries()) {
      await admin()
        .firestore.doc(`users/${uid}`)
        .set({
          role: 'DRIVER',
          name: `Paged Driver ${index}`,
          email: `${uid}@example.test`,
          status: 'ACTIVE',
          createdAt: now,
          updatedAt: now,
        });
      await admin().firestore.doc(`drivers/${uid}`).set({
        userId: uid,
        verificationStatus: statuses[index],
        verificationReason: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    return uids;
  }

  async function walk(reviewerClient: Client, pageSize: number) {
    const pages: Awaited<ReturnType<typeof listDriversForReview>>['rows'][] = [];
    let cursor: Awaited<ReturnType<typeof listDriversForReview>>['nextCursor'] = null;
    do {
      const page = await listDriversForReview(reviewerClient, { cursor, pageSize });
      pages.push(page.rows);
      cursor = page.nextCursor;
    } while (cursor);
    return pages;
  }

  it('reads a page at a time, every driver once, pending first', async () => {
    const reviewer = await staff('ADMIN', 'admpage-reviewer');
    const uids = await seedDrivers('admpage', [
      'VERIFIED',
      'PENDING',
      'REJECTED',
      'VERIFIED',
      'PENDING',
      'VERIFIED',
      'REJECTED',
    ]);

    const pages = await walk(reviewer.client, 3);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((rows) => rows.length <= 3)).toBe(true);
    const mine = pages.flat().filter((row) => uids.includes(row.uid));
    expect(mine.map((row) => row.uid).sort()).toEqual([...uids].sort());
    const ranks = mine.map((row) => STATUS_RANK[row.driverVerificationStatus]!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(mine[0]?.driverVerificationStatus).toBe('PENDING');
  });

  it('offers no next page after a page that ends the list, even when it is exactly full', async () => {
    const reviewer = await staff('ADMIN', 'admpage-full');
    await seedDrivers('admfull', ['PENDING', 'VERIFIED', 'VERIFIED']);
    const total = (await walk(reviewer.client, 1000)).flat().length;

    const exact = await listDriversForReview(reviewer.client, { pageSize: total });
    expect(exact.rows).toHaveLength(total);
    expect(exact.nextCursor).toBeNull();

    const oneShort = await listDriversForReview(reviewer.client, { pageSize: total - 1 });
    expect(oneShort.rows).toHaveLength(total - 1);
    expect(oneShort.nextCursor).not.toBeNull();
  });

  it('continues exactly where the page before it stopped', async () => {
    const reviewer = await staff('ADMIN', 'admpage-cursor');
    await seedDrivers('admcursor', ['PENDING', 'REJECTED', 'VERIFIED', 'VERIFIED', 'PENDING']);
    const everything = (await walk(reviewer.client, 1000)).flat().map((row) => row.uid);

    const first = await listDriversForReview(reviewer.client, { pageSize: 2 });
    const second = await listDriversForReview(reviewer.client, {
      pageSize: 2,
      cursor: first.nextCursor,
    });

    expect([...first.rows, ...second.rows].map((row) => row.uid)).toEqual(everything.slice(0, 4));
  });
});
