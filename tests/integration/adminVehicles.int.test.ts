import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import {
  listVehiclesForReview,
  saveVehicle,
  setVehicleCapacity,
} from '../../packages/firebase/src';
import { admin, allPages, createClient, signUp, verifyEmail } from './support';
import type { StatusCursor } from '../../packages/firebase/src';

// Module 11.6 (admin dashboard: vehicle management, standalone page). listVehiclesForReview is a
// direct Firestore read (staff rules already allow listing vehicles/users in full, same as
// listDriversForReview) - this file covers the NEW client-side piece: a fleet-first row per SAVED
// vehicle only (a driver with none is simply absent), carrying seatCapacity (not on
// listDriversForReview's own vehicle shape) and the driver's own name/email to find whose it is.

let plateCounter = 0;
const uniquePlate = () => `ADMV-${Date.now() % 100000}-${plateCounter++}`;

async function driver(prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(
    client.functions,
    'completeRegistration',
  )({
    role: 'DRIVER',
    name: 'Test Driver',
  });
  await verifyEmail(user, email);
  await saveVehicle(client, {
    type: 'CAR',
    make: 'Toyota',
    model: 'Corolla',
    plateNumber: uniquePlate(),
  });
  await setVehicleCapacity(client, 4);
  return { client, uid, email };
}

async function staff(prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await admin().auth.setCustomUserClaims(uid, { role: 'ADMIN' });
  await verifyEmail(user, email);
  return { client, uid };
}

describe('listVehiclesForReview (functions + firestore + auth emulators)', () => {
  it('lists a saved vehicle with its own driver and seat capacity', async () => {
    const reviewer = await staff('admveh-reviewer');
    const target = await driver('admveh-target');

    const rows = await allPages((cursor: StatusCursor | null) =>
      listVehiclesForReview(reviewer.client, { cursor }),
    );
    const row = rows.find((r) => r.driverId === target.uid);
    expect(row).toMatchObject({
      driverEmail: target.email,
      make: 'Toyota',
      model: 'Corolla',
      seatCapacity: 4,
      verificationStatus: 'PENDING',
    });
  });

  it('does not list a driver who has never saved a vehicle', async () => {
    const reviewer = await staff('admveh-nosave-reviewer');
    const client = createClient();
    const { user, uid, email } = await signUp(client, 'admveh-nosave');
    await httpsCallable(
      client.functions,
      'completeRegistration',
    )({
      role: 'DRIVER',
      name: 'No Vehicle',
    });
    await verifyEmail(user, email);

    const rows = await allPages((cursor: StatusCursor | null) =>
      listVehiclesForReview(reviewer.client, { cursor }),
    );
    expect(rows.some((r) => r.driverId === uid)).toBe(false);
  });

  it('puts a pending vehicle ahead of an already-reviewed one', async () => {
    const reviewer = await staff('admveh-order-reviewer');
    const pending = await driver('admveh-order-pending');
    const verified = await driver('admveh-order-verified');
    await httpsCallable(
      reviewer.client.functions,
      'reviewVehicle',
    )({
      driverId: verified.uid,
      decision: 'VERIFIED',
    });

    const rows = await allPages((cursor: StatusCursor | null) =>
      listVehiclesForReview(reviewer.client, { cursor }),
    );
    const pendingRow = rows.find((r) => r.driverId === pending.uid);
    const verifiedRow = rows.find((r) => r.driverId === verified.uid);
    expect(pendingRow?.verificationStatus).toBe('PENDING');
    expect(verifiedRow?.verificationStatus).toBe('VERIFIED');
    expect(rows.indexOf(pendingRow!)).toBeLessThan(rows.indexOf(verifiedRow!));
  });
});

// Phase 14 (performance): a page of vehicles, not the whole fleet. The emulator is shared with every
// other spec, so these seed their own vehicles and look for them across the pages.
describe('listVehiclesForReview paging', () => {
  const STATUS_RANK: Record<string, number> = { PENDING: 0, REJECTED: 1, VERIFIED: 2 };

  async function seedVehicles(prefix: string, statuses: string[]) {
    const stamp = Date.now();
    const uids = statuses.map((_, index) => `${prefix}-${stamp}-${index}`);
    const now = new Date();
    for (const [index, uid] of uids.entries()) {
      await admin()
        .firestore.doc(`users/${uid}`)
        .set({
          role: 'DRIVER',
          name: `Paged Owner ${index}`,
          email: `${uid}@example.test`,
          status: 'ACTIVE',
          createdAt: now,
          updatedAt: now,
        });
      await admin()
        .firestore.doc(`vehicles/${uid}`)
        .set({
          driverId: uid,
          type: 'CAR',
          make: 'Toyota',
          model: 'Prius',
          plateNumber: `PG${index}`,
          plateKey: `PG${index}${stamp}`,
          verificationStatus: statuses[index],
          verificationReason: null,
          createdAt: now,
          updatedAt: now,
        });
    }
    return uids;
  }

  async function walk(client: Awaited<ReturnType<typeof staff>>['client'], pageSize: number) {
    const pages: Awaited<ReturnType<typeof listVehiclesForReview>>['rows'][] = [];
    let cursor: Awaited<ReturnType<typeof listVehiclesForReview>>['nextCursor'] = null;
    do {
      const page = await listVehiclesForReview(client, { cursor, pageSize });
      pages.push(page.rows);
      cursor = page.nextCursor;
    } while (cursor);
    return pages;
  }

  it('reads a page at a time, every vehicle once, pending first', async () => {
    const reviewer = await staff('vehpage-reviewer');
    const uids = await seedVehicles('vehpage', [
      'VERIFIED',
      'PENDING',
      'REJECTED',
      'VERIFIED',
      'PENDING',
      'VERIFIED',
    ]);

    const pages = await walk(reviewer.client, 3);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((rows) => rows.length <= 3)).toBe(true);
    const mine = pages.flat().filter((row) => uids.includes(row.driverId));
    expect(mine.map((row) => row.driverId).sort()).toEqual([...uids].sort());
    const ranks = mine.map((row) => STATUS_RANK[row.verificationStatus]!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(mine[0]?.verificationStatus).toBe('PENDING');
  });

  it('offers no next page after a page that ends the list, even when it is exactly full', async () => {
    const reviewer = await staff('vehpage-full');
    await seedVehicles('vehfull', ['PENDING', 'VERIFIED']);
    const total = (await walk(reviewer.client, 1000)).flat().length;

    const exact = await listVehiclesForReview(reviewer.client, { pageSize: total });
    expect(exact.rows).toHaveLength(total);
    expect(exact.nextCursor).toBeNull();
    const oneShort = await listVehiclesForReview(reviewer.client, { pageSize: total - 1 });
    expect(oneShort.nextCursor).not.toBeNull();
  });
});
