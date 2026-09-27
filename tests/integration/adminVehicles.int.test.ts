import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import {
  listVehiclesForReview,
  saveVehicle,
  setVehicleCapacity,
} from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail } from './support';

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

    const rows = await listVehiclesForReview(reviewer.client);
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

    const rows = await listVehiclesForReview(reviewer.client);
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

    const rows = await listVehiclesForReview(reviewer.client);
    const pendingRow = rows.find((r) => r.driverId === pending.uid);
    const verifiedRow = rows.find((r) => r.driverId === verified.uid);
    expect(pendingRow?.verificationStatus).toBe('PENDING');
    expect(verifiedRow?.verificationStatus).toBe('VERIFIED');
    expect(rows.indexOf(pendingRow!)).toBeLessThan(rows.indexOf(verifiedRow!));
  });
});
