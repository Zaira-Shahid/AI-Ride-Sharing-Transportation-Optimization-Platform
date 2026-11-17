import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import type { EmployeeDataExport } from '../../functions/src/employeeDataRights';
import { deleteEmployeeAccount } from '../../functions/src/employeeDataRights';
import { admin } from './support';
import {
  account,
  auditOf,
  call,
  claimsOf,
  doc,
  firestore,
  founder,
  joined,
  refused,
  result,
  signBackIn,
  type Founder,
} from './company-support';

// Module A2c: employee data rights (functions + firestore + auth emulators). See
// docs/a2c-employee-data-rights-design.md.

let plateCounter = 0;
const plate = () => `DR-${Date.now() % 100000}-${plateCounter++}`;

/** A joined employee who applied, added a vehicle and was approved by the administrator. */
async function approvedDriver(boss: Founder, prefix: string) {
  const employee = await joined(boss, prefix);
  await call(employee.client, 'applyToDrive');
  await call(employee.client, 'saveEmployeeVehicle', {
    type: 'CAR',
    make: 'Toyota',
    model: 'Corolla',
    plateNumber: plate(),
  });
  await call(boss.client, 'approveEmployeeDriver', { uid: employee.uid });
  return employee;
}

const place = (name: string) => ({ latitude: 51.5, longitude: -0.1, formattedAddress: name });

/** A company ride seeded directly: rides are not created for employees until module A3. */
async function seedRide(fields: Record<string, unknown>) {
  const ref = firestore().collection('tripRequests').doc();
  await ref.set({
    status: 'COMPLETED',
    requestedAt: Timestamp.now(),
    endedAt: Timestamp.now(),
    sharedRide: true,
    paymentStatus: 'NONE',
    ...fields,
  });
  return ref;
}

const accountGone = async (uid: string) => {
  const lookup = await admin()
    .auth.getUser(uid)
    .then(
      () => null,
      (error: { code?: string }) => error.code,
    );
  return lookup === 'auth/user-not-found';
};

describe('exportMyData for an employee', () => {
  it('returns what the person gave or generated, and nothing about anyone else', async () => {
    const boss = await founder('export', 'Export Co');
    const other = await joined(boss, 'export-other');
    const employee = await approvedDriver(boss, 'export-employee');

    await firestore().collection('notifications').add({
      recipientId: employee.uid,
      type: 'INFO',
      message: 'Hello',
      createdAt: Timestamp.now(),
    });
    await seedRide({
      passengerId: employee.uid,
      origin: place('1 Home Road'),
      destination: place('2 Work Lane'),
    });
    await seedRide({
      matchedDriverId: employee.uid,
      passengerId: other.uid,
      passengerName: 'Other Rider',
      origin: place('9 Secret Street'),
      destination: place('8 Hidden Avenue'),
    });

    const data = await result<EmployeeDataExport>(employee.client, 'exportMyData');

    expect(data.profile).toMatchObject({
      name: 'New Person',
      email: employee.email.toLowerCase(),
      status: 'ACTIVE',
    });
    expect(data.company).toMatchObject({
      name: 'Export Co',
      companyRole: 'EMPLOYEE',
      membershipStatus: 'ACTIVE',
    });
    expect(data.driving).toMatchObject({
      applied: true,
      canDrive: true,
      driverVerificationStatus: 'VERIFIED',
      vehicle: { make: 'Toyota', model: 'Corolla', verificationStatus: 'VERIFIED' },
    });
    expect(data.invitation).toMatchObject({ status: 'ACCEPTED' });
    expect(data.notifications).toHaveLength(1);
    expect(data.ridesTaken).toHaveLength(1);
    expect(data.ridesTaken[0]).toMatchObject({
      origin: { formattedAddress: '1 Home Road' },
      destination: { formattedAddress: '2 Work Lane' },
    });
    expect(data.ridesDriven).toHaveLength(1);
    expect(data.truncated).toBe(false);

    // Nothing about the other member, the rider this person drove, or anything internal.
    const text = JSON.stringify(data);
    for (const forbidden of [
      other.email.toLowerCase(),
      other.uid,
      'Other Rider',
      '9 Secret Street',
      '8 Hidden Avenue',
      'tokenHash',
      boss.uid,
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(await auditOf(`users/${employee.uid}`, 'ACCOUNT_DATA_EXPORTED')).toHaveLength(1);
  });

  it('works for a person who is not driving, with no vehicle section filled in', async () => {
    const boss = await founder('export-plain');
    const data = await result<EmployeeDataExport>(boss.client, 'exportMyData');
    expect(data.company).toMatchObject({ companyRole: 'COMPANY_ADMIN' });
    expect(data.driving).toMatchObject({ applied: false, canDrive: false, vehicle: null });
    expect(data.invitation).toBeNull();
    expect(data.ridesTaken).toEqual([]);
  });

  it('still works for someone removed from the company, whose token has no role', async () => {
    const boss = await founder('export-removed');
    const worker = await joined(boss, 'export-removed-worker');
    await call(boss.client, 'removeEmployee', { uid: worker.uid });
    await signBackIn(worker);
    expect(await claimsOf(worker.uid)).toEqual({});

    const data = await result<EmployeeDataExport>(worker.client, 'exportMyData');
    expect(data.profile.status).toBe('SUSPENDED');
    expect(data.company).toMatchObject({ membershipStatus: 'REMOVED' });
  });

  it('does not open the employee path to a new account with no profile, or to an unverified one', async () => {
    const stranger = await account('export-stranger');
    await expect(call(stranger.client, 'exportMyData')).rejects.toMatchObject(
      refused('permission-denied'),
    );
  });

  it('is limited to five exports an hour', async () => {
    const boss = await founder('export-rate');
    for (let i = 0; i < 5; i += 1) await call(boss.client, 'exportMyData');
    await expect(call(boss.client, 'exportMyData')).rejects.toMatchObject(
      refused('resource-exhausted'),
    );
  });

  it('leaves consumers on their own paths', async () => {
    const passenger = await account('export-passenger');
    await call(passenger.client, 'completeRegistration', { role: 'PASSENGER', name: 'P' });
    await passenger.user.getIdToken(true);
    const passengerData = await result<Record<string, unknown>>(passenger.client, 'exportMyData');
    expect(passengerData).toHaveProperty('receipts');
    expect(passengerData).not.toHaveProperty('company');

    const driver = await account('export-driver');
    await call(driver.client, 'completeRegistration', { role: 'DRIVER', name: 'D' });
    await driver.user.getIdToken(true);
    const driverData = await result<Record<string, unknown>>(driver.client, 'exportMyData');
    expect(driverData).toHaveProperty('earnings');
    expect(driverData).not.toHaveProperty('company');
  });
});

describe('deleteMyAccount for an employee', () => {
  it('needs the confirmation, and is limited to three attempts an hour', async () => {
    const boss = await founder('delete-confirm');
    for (let i = 0; i < 3; i += 1) {
      await expect(call(boss.client, 'deleteMyAccount', { confirm: 'no' })).rejects.toMatchObject(
        refused('invalid-argument'),
      );
    }
    await expect(call(boss.client, 'deleteMyAccount', { confirm: 'DELETE' })).rejects.toMatchObject(
      refused('resource-exhausted'),
    );
    expect((await doc(`users/${boss.uid}`))?.role).toBe('EMPLOYEE');
  });

  it('refuses while a driver is online or a journey is active, and changes nothing', async () => {
    const boss = await founder('delete-online');
    const employee = await approvedDriver(boss, 'delete-online-employee');
    await firestore().doc(`drivers/${employee.uid}`).update({ availabilityStatus: 'ONLINE' });
    await expect(
      call(employee.client, 'deleteMyAccount', { confirm: 'DELETE' }),
    ).rejects.toMatchObject(refused('failed-precondition', 'Go offline'));

    await firestore().doc(`drivers/${employee.uid}`).update({ availabilityStatus: 'OFFLINE' });
    const journey = firestore().collection('driverJourneys').doc();
    await journey.set({ driverId: employee.uid, status: 'AVAILABLE', matchedTripRequestIds: [] });
    await expect(
      call(employee.client, 'deleteMyAccount', { confirm: 'DELETE' }),
    ).rejects.toMatchObject(refused('failed-precondition', 'journey'));

    expect((await doc(`users/${employee.uid}`))?.role).toBe('EMPLOYEE');
    expect((await doc(`vehicles/${employee.uid}`))?.driverId).toBe(employee.uid);
    expect(await accountGone(employee.uid)).toBe(false);
  });

  it.each([
    ['as a rider', (uid: string) => ({ passengerId: uid, status: 'SEARCHING' })],
    ['as a driver', (uid: string) => ({ matchedDriverId: uid, status: 'IN_TRANSIT' })],
  ])('refuses while a ride is in flight %s', async (_name, ride) => {
    const boss = await founder('delete-ride');
    const employee = await joined(boss, 'delete-ride-employee');
    await seedRide(ride(employee.uid));
    await expect(
      call(employee.client, 'deleteMyAccount', { confirm: 'DELETE' }),
    ).rejects.toMatchObject(refused('failed-precondition', 'ride'));
    expect((await doc(`users/${employee.uid}`))?.role).toBe('EMPLOYEE');
  });

  it('refuses the last administrator while other members remain, and allows it once there is another', async () => {
    const boss = await founder('delete-last-admin');
    const worker = await joined(boss, 'delete-last-admin-worker');
    await expect(call(boss.client, 'deleteMyAccount', { confirm: 'DELETE' })).rejects.toMatchObject(
      refused('failed-precondition', 'last administrator'),
    );
    expect((await doc(`users/${boss.uid}`))?.role).toBe('EMPLOYEE');
    expect((await doc(`companies/${boss.companyId}`))?.status).toBe('ACTIVE');

    await call(boss.client, 'setEmployeeRole', { uid: worker.uid, companyRole: 'COMPANY_ADMIN' });
    await expect(
      result<{ status: string }>(boss.client, 'deleteMyAccount', { confirm: 'DELETE' }),
    ).resolves.toEqual({ status: 'deleted' });
    expect((await doc(`companies/${boss.companyId}`))?.status).toBe('ACTIVE');
    expect(await accountGone(boss.uid)).toBe(true);
  });

  it('deletes the person, anonymizes their rides and keeps the company and the others intact', async () => {
    const boss = await founder('delete-full');
    const other = await joined(boss, 'delete-full-other');
    const employee = await approvedDriver(boss, 'delete-full-employee');
    await firestore()
      .collection('notifications')
      .add({ recipientId: employee.uid, type: 'INFO', message: 'Hi', createdAt: Timestamp.now() });
    const taken = await seedRide({
      passengerId: employee.uid,
      passengerName: 'New Person',
      origin: place('1 Home Road'),
      destination: place('2 Work Lane'),
      driverName: 'Someone Else',
    });
    const driven = await seedRide({
      matchedDriverId: employee.uid,
      driverName: 'New Person',
      vehiclePlateNumber: 'ABC123',
      vehicleMake: 'Toyota',
      passengerId: other.uid,
      passengerName: 'Other Person',
      origin: place('9 Rider Street'),
    });
    const invitation = (
      await firestore()
        .collection('companyInvitations')
        .where('acceptedBy', '==', employee.uid)
        .get()
    ).docs[0]!;

    expect(
      await result<{ status: string }>(employee.client, 'deleteMyAccount', { confirm: 'DELETE' }),
    ).toEqual({ status: 'deleted' });

    // Gone: profile, driver profile, vehicle, notifications, sign-in account.
    expect((await doc(`users/${employee.uid}`)) ?? null).toBeNull();
    expect((await doc(`drivers/${employee.uid}`)) ?? null).toBeNull();
    expect((await doc(`vehicles/${employee.uid}`)) ?? null).toBeNull();
    expect(
      (await firestore().collection('notifications').where('recipientId', '==', employee.uid).get())
        .size,
    ).toBe(0);
    expect(await accountGone(employee.uid)).toBe(true);

    // Kept, stripped: the membership, under the uid.
    expect(await doc(`companies/${boss.companyId}/members/${employee.uid}`)).toMatchObject({
      status: 'REMOVED',
      canDrive: false,
      driverReviewedBy: null,
      driverRequestedAt: null,
    });
    // The accepted invitation lost the email but kept its status.
    expect((await invitation.ref.get()).data()).toMatchObject({ email: null, status: 'ACCEPTED' });

    // Their own ride is anonymized; the one they drove loses the driver but keeps the rider's side.
    expect((await taken.get()).data()).toMatchObject({
      passengerId: null,
      passengerName: 'Deleted passenger',
      origin: null,
      destination: null,
      placesCleared: true,
    });
    expect((await driven.get()).data()).toMatchObject({
      matchedDriverId: null,
      driverName: null,
      vehiclePlateNumber: null,
      vehicleMake: null,
      passengerId: other.uid,
      passengerName: 'Other Person',
      origin: place('9 Rider Street'),
    });

    // Nothing else changed.
    expect((await doc(`companies/${boss.companyId}`))?.status).toBe('ACTIVE');
    expect((await doc(`users/${other.uid}`))?.status).toBe('ACTIVE');
    expect((await doc(`users/${boss.uid}`))?.status).toBe('ACTIVE');
    expect(await auditOf(`users/${employee.uid}`, 'ACCOUNT_DELETED')).toHaveLength(1);
  });

  it('frees the vehicle plate for another driver', async () => {
    const boss = await founder('delete-plate');
    const employee = await approvedDriver(boss, 'delete-plate-employee');
    const plateNumber = (await doc(`vehicles/${employee.uid}`))?.plateNumber as string;
    await call(employee.client, 'deleteMyAccount', { confirm: 'DELETE' });

    const next = await joined(boss, 'delete-plate-next');
    await call(next.client, 'applyToDrive');
    await expect(
      call(next.client, 'saveEmployeeVehicle', {
        type: 'CAR',
        make: 'Ford',
        model: 'Focus',
        plateNumber,
      }),
    ).resolves.toMatchObject({ data: { status: 'created' } });
  });

  it('closes the company when its only active member deletes their account', async () => {
    const boss = await founder('delete-sole', 'Closing Co');
    await call(boss.client, 'deleteMyAccount', { confirm: 'DELETE' });
    expect(await doc(`companies/${boss.companyId}`)).toMatchObject({
      status: 'SUSPENDED',
      statusReason: 'Closed by its last member',
    });
    expect(await auditOf(`companies/${boss.companyId}`, 'COMPANY_CLOSED')).toHaveLength(1);
    expect(await accountGone(boss.uid)).toBe(true);
  });

  it('lets a removed employee delete their account, without touching the company', async () => {
    const boss = await founder('delete-removed', 'Still Open Co');
    const worker = await joined(boss, 'delete-removed-worker');
    await call(boss.client, 'removeEmployee', { uid: worker.uid });
    await signBackIn(worker);

    await expect(
      result<{ status: string }>(worker.client, 'deleteMyAccount', { confirm: 'DELETE' }),
    ).resolves.toEqual({ status: 'deleted' });
    expect((await doc(`users/${worker.uid}`)) ?? null).toBeNull();
    expect(await accountGone(worker.uid)).toBe(true);
    expect((await doc(`companies/${boss.companyId}`))?.status).toBe('ACTIVE');
    expect((await doc(`companies/${boss.companyId}/members/${worker.uid}`))?.status).toBe(
      'REMOVED',
    );
  });

  it('finishes a deletion that stopped half way', async () => {
    const boss = await founder('delete-resume');
    const worker = await joined(boss, 'delete-resume-worker');
    // The profile is already gone (the call stopped before deleting the sign-in account).
    await firestore().doc(`users/${worker.uid}`).delete();
    expect(await accountGone(worker.uid)).toBe(false);
    await expect(
      result<{ status: string }>(worker.client, 'deleteMyAccount', { confirm: 'DELETE' }),
    ).resolves.toEqual({ status: 'deleted' });
    expect(await accountGone(worker.uid)).toBe(true);
  });

  it('records the deletion outside Firestore with the uid and role only', async () => {
    const boss = await founder('delete-log');
    const worker = await joined(boss, 'delete-log-worker');
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    await deleteEmployeeAccount(
      {
        firestore: firestore(),
        auth: admin().auth,
        log: (event, fields) => events.push({ event, fields }),
      },
      { uid: worker.uid, role: 'EMPLOYEE', emailVerified: true },
      { confirm: 'DELETE' },
    );
    expect(events).toEqual([
      {
        event: 'ACCOUNT_DELETED',
        fields: { event: 'ACCOUNT_DELETED', uid: worker.uid, role: 'EMPLOYEE' },
      },
    ]);
  });

  it('is not reachable by a consumer, and does not touch consumer deletion', async () => {
    const stranger = await account('delete-stranger');
    await expect(
      call(stranger.client, 'deleteMyAccount', { confirm: 'DELETE' }),
    ).rejects.toMatchObject(refused('permission-denied'));

    const passenger = await account('delete-passenger');
    await call(passenger.client, 'completeRegistration', { role: 'PASSENGER', name: 'P' });
    await passenger.user.getIdToken(true);
    await expect(
      result<{ status: string }>(passenger.client, 'deleteMyAccount', { confirm: 'DELETE' }),
    ).resolves.toEqual({ status: 'deleted' });
    expect(await accountGone(passenger.uid)).toBe(true);
  });
});
