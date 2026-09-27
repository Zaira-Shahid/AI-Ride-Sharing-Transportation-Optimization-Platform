import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import { listDriversForReview, saveVehicle, submitStaffReview } from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

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

    const rows = await listDriversForReview(reviewer.client);
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

    const rows = await listDriversForReview(reviewer.client);
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

    const rows = await listDriversForReview(reviewer.client);
    const row = rows.find((r) => r.uid === target.uid);
    expect(row?.driverVerificationStatus).toBe('VERIFIED');
    expect(row?.vehicle?.verificationStatus).toBe('VERIFIED');
  });

  it('rejects with a reason that shows up on the next read', async () => {
    const reviewer = await staff('ADMIN', 'admrev-reject-reviewer');
    const target = await driver('admrev-reject-target');

    await submitStaffReview(reviewer.client, 'DRIVER', target.uid, 'REJECTED', 'Bad photo.');
    const rows = await listDriversForReview(reviewer.client);
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
