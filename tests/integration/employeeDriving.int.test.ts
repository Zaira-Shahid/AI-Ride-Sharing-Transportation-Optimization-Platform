import { describe, expect, it } from 'vitest';
import type {
  ApplyToDriveResult,
  ApproveEmployeeDriverResult,
  ListDriverApplicationsResult,
  RejectEmployeeDriverResult,
  RevokeEmployeeDriverResult,
} from '../../packages/tenancy/src';
import { approveEmployeeDriver } from '../../functions/src/employeeDriving';
import { admin } from './support';
import {
  account,
  auditOf,
  call,
  doc,
  firestore,
  founder,
  joined,
  refused,
  result,
  type Founder,
} from './company-support';

// Module A2b: the driving capability for company employees (functions + firestore + auth
// emulators). See docs/a2b-driver-capability-design.md.

let plateCounter = 0;
const plate = () => `EMP-${Date.now() % 100000}-${plateCounter++}`;
const vehicleInput = (plateNumber = plate()) => ({
  type: 'CAR',
  make: 'Toyota',
  model: 'Corolla',
  plateNumber,
});

/** A joined employee who has applied and added a vehicle, ready for the administrator to review. */
async function applicant(boss: Founder, prefix: string) {
  const employee = await joined(boss, prefix);
  await call(employee.client, 'applyToDrive');
  await call(employee.client, 'saveEmployeeVehicle', vehicleInput());
  return employee;
}

const adminCaller = (boss: Founder) => ({
  uid: boss.uid,
  role: 'EMPLOYEE',
  emailVerified: true,
  companyId: boss.companyId,
});
const quietPush = { sendPush: () => Promise.resolve({ status: 'sent' as const }) };

const memberOf = (boss: Founder, uid: string) => doc(`companies/${boss.companyId}/members/${uid}`);

describe('applyToDrive', () => {
  it('records the application and creates the driver profile, once', async () => {
    const boss = await founder('apply');
    const employee = await joined(boss, 'apply-employee');

    expect(await result<ApplyToDriveResult>(employee.client, 'applyToDrive')).toEqual({
      status: 'applied',
    });
    expect(await doc(`drivers/${employee.uid}`)).toMatchObject({
      userId: employee.uid,
      verificationStatus: 'PENDING',
      availabilityStatus: 'OFFLINE',
    });
    const member = await memberOf(boss, employee.uid);
    expect(member?.driverRequestedAt).toBeTruthy();
    expect(member?.canDrive).toBe(false);

    expect(await result<ApplyToDriveResult>(employee.client, 'applyToDrive')).toEqual({
      status: 'unchanged',
    });
    expect(
      await auditOf(
        `companies/${boss.companyId}/members/${employee.uid}`,
        'EMPLOYEE_DRIVER_APPLIED',
      ),
    ).toHaveLength(1);
    expect(await auditOf(`drivers/${employee.uid}`, 'DRIVER_PROFILE_CREATED')).toHaveLength(1);
  });

  it('lets an administrator apply too', async () => {
    const boss = await founder('apply-admin');
    expect(await result<ApplyToDriveResult>(boss.client, 'applyToDrive')).toEqual({
      status: 'applied',
    });
  });

  it('is refused for consumers, unverified accounts and people removed from the company', async () => {
    const consumer = await account('apply-consumer');
    await call(consumer.client, 'completeRegistration', { role: 'DRIVER', name: 'D' });
    await consumer.user.getIdToken(true);
    await expect(call(consumer.client, 'applyToDrive')).rejects.toMatchObject(
      refused('permission-denied'),
    );

    const unverified = await account('apply-unverified', false);
    await expect(call(unverified.client, 'applyToDrive')).rejects.toMatchObject(
      refused('permission-denied'),
    );

    const boss = await founder('apply-removed');
    const gone = await joined(boss, 'apply-gone');
    await call(boss.client, 'removeEmployee', { uid: gone.uid });
    // Their token still names the company: the membership is what counts.
    await expect(call(gone.client, 'applyToDrive')).rejects.toMatchObject(
      refused('permission-denied'),
    );
    expect((await doc(`drivers/${gone.uid}`)) ?? null).toBeNull();
  });
});

describe('the employee vehicle', () => {
  it('needs an application first', async () => {
    const boss = await founder('veh-first');
    const employee = await joined(boss, 'veh-first-employee');
    await expect(
      call(employee.client, 'saveEmployeeVehicle', vehicleInput()),
    ).rejects.toMatchObject(refused('failed-precondition', 'Apply to drive first'));
    expect((await doc(`vehicles/${employee.uid}`)) ?? null).toBeNull();
  });

  it('is saved with the same rules as any driver: pending review, unique plate, valid details', async () => {
    const boss = await founder('veh');
    const employee = await joined(boss, 'veh-employee');
    await call(employee.client, 'applyToDrive');

    const input = vehicleInput();
    expect((await call(employee.client, 'saveEmployeeVehicle', input)).data).toEqual({
      status: 'created',
    });
    expect(await doc(`vehicles/${employee.uid}`)).toMatchObject({
      driverId: employee.uid,
      make: 'Toyota',
      verificationStatus: 'PENDING',
    });
    expect((await call(employee.client, 'saveEmployeeVehicle', input)).data).toEqual({
      status: 'unchanged',
    });

    const other = await joined(boss, 'veh-other');
    await call(other.client, 'applyToDrive');
    await expect(
      call(other.client, 'saveEmployeeVehicle', vehicleInput(input.plateNumber)),
    ).rejects.toMatchObject(refused('already-exists'));
    await expect(
      call(other.client, 'saveEmployeeVehicle', { ...vehicleInput(), plateNumber: '!!' }),
    ).rejects.toMatchObject(refused('invalid-argument'));

    expect(
      (await call(employee.client, 'setEmployeeVehicleCapacity', { seatCapacity: 4 })).data,
    ).toEqual({
      status: 'updated',
    });
    await expect(
      call(employee.client, 'setEmployeeVehicleCapacity', { seatCapacity: 9 }),
    ).rejects.toMatchObject(refused('invalid-argument'));
  });

  it('cannot be saved by someone who is not an active employee', async () => {
    const consumer = await account('veh-consumer');
    await call(consumer.client, 'completeRegistration', { role: 'PASSENGER', name: 'P' });
    await consumer.user.getIdToken(true);
    await expect(
      call(consumer.client, 'saveEmployeeVehicle', vehicleInput()),
    ).rejects.toMatchObject(refused('permission-denied'));
  });
});

describe('listDriverApplications', () => {
  it('shows the company applicants with their statuses and vehicle, and nothing about places', async () => {
    const boss = await founder('list');
    const ready = await applicant(boss, 'list-ready');
    const notYet = await joined(boss, 'list-not-yet');
    await call(notYet.client, 'applyToDrive');
    const bystander = await joined(boss, 'list-bystander');

    const listed = await result<ListDriverApplicationsResult>(
      boss.client,
      'listDriverApplications',
    );
    const byUid = new Map(listed.rows.map((row) => [row.uid, row]));
    expect(byUid.has(bystander.uid)).toBe(false);

    const row = byUid.get(ready.uid)!;
    expect(row).toMatchObject({
      name: 'New Person',
      email: ready.email.toLowerCase(),
      driverStatus: 'PENDING',
      needsReview: true,
      vehicle: { type: 'CAR', make: 'Toyota', model: 'Corolla', status: 'PENDING' },
    });
    expect(byUid.get(notYet.uid)).toMatchObject({ vehicle: null, needsReview: false });

    const text = JSON.stringify(listed);
    for (const forbidden of ['origin', 'destination', 'latitude', 'longitude', 'address', 'trip']) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
    // Waiting for a decision comes first.
    expect(listed.rows[0]?.needsReview).toBe(true);
  });

  it("never shows another company's applicants, and is for administrators only", async () => {
    const a = await founder('list-a');
    const b = await founder('list-b');
    const mine = await applicant(a, 'list-a-applicant');
    const seenByB = await result<ListDriverApplicationsResult>(b.client, 'listDriverApplications');
    expect(seenByB.rows.map((row) => row.uid)).not.toContain(mine.uid);
    await expect(call(mine.client, 'listDriverApplications')).rejects.toMatchObject(
      refused('permission-denied'),
    );
  });
});

describe('approveEmployeeDriver', () => {
  it('verifies both and grants the capability, audited', async () => {
    const boss = await founder('approve');
    const employee = await applicant(boss, 'approve-employee');

    expect(
      await result<ApproveEmployeeDriverResult>(boss.client, 'approveEmployeeDriver', {
        uid: employee.uid,
      }),
    ).toEqual({ status: 'approved' });

    expect((await doc(`drivers/${employee.uid}`))?.verificationStatus).toBe('VERIFIED');
    expect((await doc(`vehicles/${employee.uid}`))?.verificationStatus).toBe('VERIFIED');
    expect(await memberOf(boss, employee.uid)).toMatchObject({
      canDrive: true,
      driverReviewedBy: boss.uid,
      driverRequestedAt: null,
    });
    expect(
      await auditOf(
        `companies/${boss.companyId}/members/${employee.uid}`,
        'EMPLOYEE_DRIVER_APPROVED',
      ),
    ).toHaveLength(1);
    expect(await auditOf(`drivers/${employee.uid}`, 'DRIVER_VERIFICATION_REVIEWED')).toHaveLength(
      1,
    );
    expect(await auditOf(`vehicles/${employee.uid}`, 'VEHICLE_VERIFICATION_REVIEWED')).toHaveLength(
      1,
    );

    // Safe to repeat.
    expect(
      await result<ApproveEmployeeDriverResult>(boss.client, 'approveEmployeeDriver', {
        uid: employee.uid,
      }),
    ).toEqual({ status: 'unchanged' });
  });

  it('is not available to the employee themselves, or to a plain employee', async () => {
    const boss = await founder('approve-who');
    const employee = await applicant(boss, 'approve-who-employee');
    await expect(
      call(employee.client, 'approveEmployeeDriver', { uid: employee.uid }),
    ).rejects.toMatchObject(refused('permission-denied'));
    expect((await memberOf(boss, employee.uid))?.canDrive).toBe(false);
  });

  it('refuses an administrator approving themselves, and lets another administrator do it', async () => {
    const boss = await founder('approve-self');
    await call(boss.client, 'applyToDrive');
    await call(boss.client, 'saveEmployeeVehicle', vehicleInput());
    await expect(
      call(boss.client, 'approveEmployeeDriver', { uid: boss.uid }),
    ).rejects.toMatchObject(refused('permission-denied', 'your own'));
    expect((await doc(`drivers/${boss.uid}`))?.verificationStatus).toBe('PENDING');
    expect((await memberOf(boss, boss.uid))?.canDrive).toBe(false);

    const second = await joined(boss, 'approve-second-admin', 'COMPANY_ADMIN');
    await expect(
      result<ApproveEmployeeDriverResult>(second.client, 'approveEmployeeDriver', {
        uid: boss.uid,
      }),
    ).resolves.toEqual({ status: 'approved' });
    expect((await memberOf(boss, boss.uid))?.canDrive).toBe(true);
  });

  it("cannot reach another company's employees", async () => {
    const a = await founder('approve-a');
    const b = await founder('approve-b');
    const theirs = await applicant(b, 'approve-b-employee');
    await expect(
      call(a.client, 'approveEmployeeDriver', { uid: theirs.uid }),
    ).rejects.toMatchObject(refused('not-found'));
    expect((await doc(`drivers/${theirs.uid}`))?.verificationStatus).toBe('PENDING');
    expect((await memberOf(b, theirs.uid))?.canDrive).toBe(false);
  });

  it('changes nothing when there is no application or no vehicle', async () => {
    const boss = await founder('approve-missing');
    const never = await joined(boss, 'approve-never');
    await expect(
      call(boss.client, 'approveEmployeeDriver', { uid: never.uid }),
    ).rejects.toMatchObject(refused('failed-precondition', 'not applied'));

    const noVehicle = await joined(boss, 'approve-no-vehicle');
    await call(noVehicle.client, 'applyToDrive');
    await expect(
      call(boss.client, 'approveEmployeeDriver', { uid: noVehicle.uid }),
    ).rejects.toMatchObject(refused('failed-precondition', 'vehicle'));
    // The driver profile must not be left half verified.
    expect((await doc(`drivers/${noVehicle.uid}`))?.verificationStatus).toBe('PENDING');
    expect((await memberOf(boss, noVehicle.uid))?.canDrive).toBe(false);
  });

  it('refuses to grant the capability when the vehicle changes during the review', async () => {
    const boss = await founder('approve-race');
    const employee = await applicant(boss, 'approve-race-employee');

    await expect(
      approveEmployeeDriver(
        {
          firestore: admin().firestore,
          push: quietPush,
          // Between the verifications and the final check, the employee edits their vehicle.
          afterReview: async () => {
            await call(employee.client, 'saveEmployeeVehicle', vehicleInput());
          },
        },
        adminCaller(boss),
        { uid: employee.uid },
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    // A legal half-way state: verified driver, vehicle back to pending, no capability.
    expect((await memberOf(boss, employee.uid))?.canDrive).toBe(false);
    expect((await doc(`vehicles/${employee.uid}`))?.verificationStatus).toBe('PENDING');
    // Reviewing again finishes the job.
    await expect(
      result<ApproveEmployeeDriverResult>(boss.client, 'approveEmployeeDriver', {
        uid: employee.uid,
      }),
    ).resolves.toEqual({ status: 'approved' });
    expect((await memberOf(boss, employee.uid))?.canDrive).toBe(true);
  });
});

describe('rejectEmployeeDriver and a second review', () => {
  it('rejects the driver profile or the vehicle with a reason, and approval works after a new request', async () => {
    const boss = await founder('reject');
    const employee = await applicant(boss, 'reject-employee');

    expect(
      await result<RejectEmployeeDriverResult>(boss.client, 'rejectEmployeeDriver', {
        uid: employee.uid,
        target: 'VEHICLE',
        reason: 'The plate does not match the photo shared.',
      }),
    ).toEqual({ status: 'rejected' });
    expect(await doc(`vehicles/${employee.uid}`)).toMatchObject({
      verificationStatus: 'REJECTED',
      verificationReason: 'The plate does not match the photo shared.',
    });
    expect((await doc(`drivers/${employee.uid}`))?.verificationStatus).toBe('PENDING');

    // Approving a rejected vehicle is not possible until the employee asks again.
    expect(
      (await call(employee.client, 'requestEmployeeDriverReview', { target: 'VEHICLE' })).data,
    ).toEqual({ status: 'requested' });
    await expect(
      result<ApproveEmployeeDriverResult>(boss.client, 'approveEmployeeDriver', {
        uid: employee.uid,
      }),
    ).resolves.toEqual({ status: 'approved' });
    expect((await memberOf(boss, employee.uid))?.canDrive).toBe(true);
  });

  it('needs a reason, an application, and is not for an approved driver', async () => {
    const boss = await founder('reject-guards');
    const employee = await applicant(boss, 'reject-guards-employee');
    await expect(
      call(boss.client, 'rejectEmployeeDriver', {
        uid: employee.uid,
        target: 'DRIVER',
        reason: '',
      }),
    ).rejects.toMatchObject(refused('invalid-argument'));
    await expect(
      call(boss.client, 'rejectEmployeeDriver', {
        uid: employee.uid,
        target: 'OTHER',
        reason: 'x',
      }),
    ).rejects.toMatchObject(refused('invalid-argument'));

    const never = await joined(boss, 'reject-guards-never');
    await expect(
      call(boss.client, 'rejectEmployeeDriver', {
        uid: never.uid,
        target: 'DRIVER',
        reason: 'No.',
      }),
    ).rejects.toMatchObject(refused('failed-precondition', 'not applied'));

    await call(boss.client, 'approveEmployeeDriver', { uid: employee.uid });
    await expect(
      call(boss.client, 'rejectEmployeeDriver', {
        uid: employee.uid,
        target: 'DRIVER',
        reason: 'Changed my mind.',
      }),
    ).rejects.toMatchObject(refused('failed-precondition', 'Revoke'));
    expect((await doc(`drivers/${employee.uid}`))?.verificationStatus).toBe('VERIFIED');
  });

  it('cannot be used on oneself or on another company', async () => {
    const a = await founder('reject-who-a');
    const b = await founder('reject-who-b');
    await call(a.client, 'applyToDrive');
    await expect(
      call(a.client, 'rejectEmployeeDriver', { uid: a.uid, target: 'DRIVER', reason: 'Self.' }),
    ).rejects.toMatchObject(refused('permission-denied'));
    const theirs = await applicant(b, 'reject-who-b-employee');
    await expect(
      call(a.client, 'rejectEmployeeDriver', { uid: theirs.uid, target: 'DRIVER', reason: 'No.' }),
    ).rejects.toMatchObject(refused('not-found'));
  });
});

describe('revokeEmployeeDriver', () => {
  it('withdraws the capability, rejects both, and takes an online driver offline', async () => {
    const boss = await founder('revoke');
    const employee = await applicant(boss, 'revoke-employee');
    await call(boss.client, 'approveEmployeeDriver', { uid: employee.uid });

    // The driver is online with an open journey.
    const journey = firestore().collection('driverJourneys').doc();
    await journey.set({ driverId: employee.uid, status: 'AVAILABLE', matchedTripRequestIds: [] });
    await firestore()
      .doc(`drivers/${employee.uid}`)
      .update({ availabilityStatus: 'ONLINE', currentJourneyId: journey.id });

    expect(
      await result<RevokeEmployeeDriverResult>(boss.client, 'revokeEmployeeDriver', {
        uid: employee.uid,
        reason: 'Left the carpool team.',
      }),
    ).toEqual({ status: 'revoked' });

    expect(await memberOf(boss, employee.uid)).toMatchObject({
      canDrive: false,
      driverReviewedBy: null,
    });
    expect(await doc(`drivers/${employee.uid}`)).toMatchObject({
      verificationStatus: 'REJECTED',
      verificationReason: 'Left the carpool team.',
      availabilityStatus: 'OFFLINE',
    });
    expect((await doc(`vehicles/${employee.uid}`))?.verificationStatus).toBe('REJECTED');
    expect((await journey.get()).get('status')).toBe('DRAFT');
    expect(
      await auditOf(
        `companies/${boss.companyId}/members/${employee.uid}`,
        'EMPLOYEE_DRIVER_REVOKED',
      ),
    ).toHaveLength(1);

    expect(
      await result<RevokeEmployeeDriverResult>(boss.client, 'revokeEmployeeDriver', {
        uid: employee.uid,
        reason: 'Left the carpool team.',
      }),
    ).toEqual({ status: 'unchanged' });
  });

  it('does nothing for someone who never drove, and needs a reason', async () => {
    const boss = await founder('revoke-nothing');
    const plain = await joined(boss, 'revoke-nothing-employee');
    expect(
      await result<RevokeEmployeeDriverResult>(boss.client, 'revokeEmployeeDriver', {
        uid: plain.uid,
        reason: 'Just in case.',
      }),
    ).toEqual({ status: 'unchanged' });
    await expect(
      call(boss.client, 'revokeEmployeeDriver', { uid: plain.uid, reason: '' }),
    ).rejects.toMatchObject(refused('invalid-argument'));
  });

  it('is refused for oneself, another company and plain employees', async () => {
    const a = await founder('revoke-who-a');
    const b = await founder('revoke-who-b');
    await expect(
      call(a.client, 'revokeEmployeeDriver', { uid: a.uid, reason: 'Self.' }),
    ).rejects.toMatchObject(refused('permission-denied'));
    const theirs = await applicant(b, 'revoke-who-b-employee');
    await expect(
      call(a.client, 'revokeEmployeeDriver', { uid: theirs.uid, reason: 'No.' }),
    ).rejects.toMatchObject(refused('not-found'));
    const worker = await joined(a, 'revoke-who-worker');
    await expect(
      call(worker.client, 'revokeEmployeeDriver', { uid: theirs.uid, reason: 'No.' }),
    ).rejects.toMatchObject(refused('permission-denied'));
  });
});

describe('what an approved employee can reach', () => {
  it('reaches the driver functions through the company adapter, but not the consumer-only ones', async () => {
    const boss = await founder('no-drive');
    const employee = await applicant(boss, 'no-drive-employee');
    await call(boss.client, 'approveEmployeeDriver', { uid: employee.uid });
    await employee.user.getIdToken(true);

    // Module A3a: the driver functions now accept an approved employee. Going online is refused for the
    // ordinary reason (no destination, seats or detour chosen yet), not because of who they are.
    await expect(
      call(employee.client, 'setAvailability', { status: 'ONLINE' }),
    ).rejects.toMatchObject(refused('failed-precondition', 'cannot go online'));
    // The consumer's own vehicle function is still not theirs: they use saveEmployeeVehicle.
    await expect(call(employee.client, 'saveVehicle', vehicleInput())).rejects.toMatchObject(
      refused('permission-denied'),
    );
    expect((await doc(`drivers/${employee.uid}`))?.availabilityStatus).toBe('OFFLINE');
  });
});
