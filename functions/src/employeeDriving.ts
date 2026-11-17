import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import type { DriverCaller } from './callers.js';
import { enforceCallRateLimit } from './callLimits.js';
import { requireActiveCompanyAdmin, type CompanyCaller } from './companies.js';
import { createDriverProfile } from './drivers.js';
import type { PushProvider } from './pushProvider.js';
import { saveVehicle, setVehicleCapacity } from './vehicles.js';
import {
  REVIEW_REASON_MAX_LENGTH,
  REVIEW_TARGETS,
  requestReview,
  reviewVerification,
} from './verification.js';

// The driving capability for company employees (module A2b, docs/a2b-driver-capability-design.md).
//
// Employee-side functions call the existing driver code (saveVehicle, setVehicleCapacity,
// requestReview) with a caller whose role is DRIVER, after checking from the membership document
// that the person is an active employee of an active company. No driver logic is rewritten here, so
// a company driver is held to the same plate, seat and verification rules as any other driver.
//
// canDrive is the administrator's permission. Whether someone can drive RIGHT NOW is that AND a
// currently VERIFIED driver profile and vehicle (hasEffectiveDriveCapability in @ridemesh/tenancy),
// so it stays correct when a vehicle is edited or platform staff change a verification.
//
// The limits and schemas below mirror @ridemesh/tenancy; tests/tenancy-parity.test.ts fails if they
// diverge.

export const APPLICATIONS_LIST_LIMIT = 100;
export const APPLY_TO_DRIVE_PER_HOUR = 10;

const HOUR_MS = 3_600_000;

const uidSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,128}$/);
const targetSchema = z.enum(REVIEW_TARGETS);
const reasonSchema = z.string().trim().min(1).max(REVIEW_REASON_MAX_LENGTH);

export const approveEmployeeDriverInputSchema = z.object({ uid: uidSchema });
export const rejectEmployeeDriverInputSchema = z.object({
  uid: uidSchema,
  target: targetSchema,
  reason: reasonSchema,
});
export const revokeEmployeeDriverInputSchema = z.object({ uid: uidSchema, reason: reasonSchema });

export interface DrivingDeps {
  firestore: Firestore;
  push: PushProvider;
  now?: () => number;
}

type Verification = 'PENDING' | 'VERIFIED' | 'REJECTED';

const EMPLOYEE_ONLY = 'Only an active employee of a company can do this.';
const SELF_REVIEW = 'You cannot review your own driver application. Ask another administrator.';
const NOT_A_MEMBER = 'There is no active employee with that ID in your company.';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function millis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function verification(value: unknown): Verification | null {
  return value === 'PENDING' || value === 'VERIFIED' || value === 'REJECTED' ? value : null;
}

function parse<T extends z.ZodType>(schema: T, raw: unknown, message: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpsError('invalid-argument', message);
  return parsed.data;
}

/**
 * The caller must be an active employee of an active company, read from the membership document
 * and not the token (a claim can be an hour stale after removal). Returns the company id.
 */
async function requireActiveEmployee(firestore: Firestore, caller: CompanyCaller): Promise<string> {
  const companyId = text(caller.companyId);
  if (!caller.emailVerified || caller.role !== 'EMPLOYEE' || companyId === null) {
    throw new HttpsError('permission-denied', EMPLOYEE_ONLY);
  }
  const [member, company] = await Promise.all([
    firestore.doc(`companies/${companyId}/members/${caller.uid}`).get(),
    firestore.doc(`companies/${companyId}`).get(),
  ]);
  if (
    !member.exists ||
    member.get('status') !== 'ACTIVE' ||
    !company.exists ||
    company.get('status') !== 'ACTIVE'
  ) {
    throw new HttpsError('permission-denied', EMPLOYEE_ONLY);
  }
  return companyId;
}

/**
 * An active employee who has applied (their driver profile exists), as the DRIVER caller the
 * existing driver code expects.
 */
async function applicantAsDriver(
  firestore: Firestore,
  caller: CompanyCaller,
): Promise<DriverCaller> {
  await requireActiveEmployee(firestore, caller);
  const driver = await firestore.doc(`drivers/${caller.uid}`).get();
  if (!driver.exists) {
    throw new HttpsError('failed-precondition', 'Apply to drive first.');
  }
  return { uid: caller.uid, role: 'DRIVER', emailVerified: true };
}

/** An active member of the administrator's own company, or a refusal that reveals nothing else. */
async function requireTargetMember(
  firestore: Firestore,
  companyId: string,
  adminUid: string,
  uid: string,
) {
  if (uid === adminUid) throw new HttpsError('permission-denied', SELF_REVIEW);
  const member = await firestore.doc(`companies/${companyId}/members/${uid}`).get();
  if (!member.exists || member.get('status') !== 'ACTIVE') {
    throw new HttpsError('not-found', NOT_A_MEMBER);
  }
  return member;
}

// ---------------------------------------------------------------------------------------------
// The employee's side

/**
 * Records that the employee wants to drive and creates their driver profile if they have none.
 * Safe to repeat. Does nothing for someone who is already approved.
 */
export async function applyToDrive(
  deps: Pick<DrivingDeps, 'firestore' | 'now'>,
  caller: CompanyCaller,
): Promise<{ status: 'applied' | 'unchanged' }> {
  const { firestore } = deps;
  const companyId = await requireActiveEmployee(firestore, caller);
  await enforceCallRateLimit(firestore, 'applyToDrive', caller.uid, (deps.now ?? Date.now)(), {
    windowMs: HOUR_MS,
    maxCalls: APPLY_TO_DRIVE_PER_HOUR,
  });

  const memberRef = firestore.doc(`companies/${companyId}/members/${caller.uid}`);
  const driverRef = firestore.doc(`drivers/${caller.uid}`);
  const userRef = firestore.doc(`users/${caller.uid}`);

  return firestore.runTransaction(async (tx): Promise<{ status: 'applied' | 'unchanged' }> => {
    const [user, driver, member] = await Promise.all([
      tx.get(userRef),
      tx.get(driverRef),
      tx.get(memberRef),
    ]);
    if (!user.exists || user.get('status') !== 'ACTIVE' || !member.exists) {
      throw new HttpsError('failed-precondition', 'This account cannot apply to drive right now.');
    }
    if (member.get('canDrive') === true) return { status: 'unchanged' };

    const alreadyRequested = member.get('driverRequestedAt') != null;
    if (driver.exists && alreadyRequested) return { status: 'unchanged' };

    if (!driver.exists) {
      createDriverProfile(
        tx,
        driverRef,
        firestore.collection('auditLogs').doc(),
        caller.uid,
        caller.uid,
        'Employee applied to drive',
      );
    }
    if (!alreadyRequested) {
      tx.update(memberRef, {
        driverRequestedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(firestore.collection('auditLogs').doc(), {
        timestamp: FieldValue.serverTimestamp(),
        actor: caller.uid,
        action: 'EMPLOYEE_DRIVER_APPLIED',
        entity: `companies/${companyId}/members/${caller.uid}`,
        previousState: { driverRequestedAt: null },
        newState: { driverRequested: true },
        reason: 'Employee applied to drive',
      });
    }
    return { status: 'applied' };
  });
}

export async function saveEmployeeVehicle(
  deps: DrivingDeps,
  caller: CompanyCaller,
  rawInput: unknown,
) {
  const driverCaller = await applicantAsDriver(deps.firestore, caller);
  return saveVehicle({ firestore: deps.firestore, push: deps.push }, driverCaller, rawInput);
}

export async function setEmployeeVehicleCapacity(
  deps: DrivingDeps,
  caller: CompanyCaller,
  rawInput: unknown,
) {
  const driverCaller = await applicantAsDriver(deps.firestore, caller);
  return setVehicleCapacity({ firestore: deps.firestore, push: deps.push }, driverCaller, rawInput);
}

export async function requestEmployeeDriverReview(
  deps: Pick<DrivingDeps, 'firestore'>,
  caller: CompanyCaller,
  rawInput: unknown,
) {
  const driverCaller = await applicantAsDriver(deps.firestore, caller);
  return requestReview({ firestore: deps.firestore }, driverCaller, rawInput);
}

// ---------------------------------------------------------------------------------------------
// The company administrator's side

/**
 * The company's applicants, with their driver and vehicle status. Returns a name, an email, the
 * verification statuses and the vehicle's own details (type, make, model, plate, seats) and nothing
 * about trips, places or locations.
 */
export async function listDriverApplications(
  deps: Pick<DrivingDeps, 'firestore'>,
  caller: CompanyCaller,
): Promise<{
  rows: {
    uid: string;
    name: string | null;
    email: string | null;
    requestedAt: number | null;
    driverStatus: Verification | null;
    driverReason: string | null;
    vehicle: {
      type: string;
      make: string;
      model: string;
      plateNumber: string;
      seatCapacity: number | null;
      status: Verification;
      reason: string | null;
    } | null;
    needsReview: boolean;
  }[];
}> {
  const { firestore } = deps;
  const companyId = await requireActiveCompanyAdmin(firestore, caller);
  const members = await firestore
    .collection(`companies/${companyId}/members`)
    .where('driverRequestedAt', '!=', null)
    .limit(APPLICATIONS_LIST_LIMIT)
    .get();
  const active = members.docs.filter((doc) => doc.get('status') === 'ACTIVE');

  const refs = active.flatMap((doc) => [
    firestore.doc(`users/${doc.id}`),
    firestore.doc(`drivers/${doc.id}`),
    firestore.doc(`vehicles/${doc.id}`),
  ]);
  const snapshots = refs.length ? await firestore.getAll(...refs) : [];

  const rows = active.map((doc, index) => {
    const user = snapshots[index * 3];
    const driver = snapshots[index * 3 + 1];
    const vehicle = snapshots[index * 3 + 2];
    const driverStatus = driver?.exists ? verification(driver.get('verificationStatus')) : null;
    const vehicleStatus = vehicle?.exists ? verification(vehicle.get('verificationStatus')) : null;
    const seats: unknown = vehicle?.get('seatCapacity');
    return {
      uid: doc.id,
      name: text(user?.get('name')),
      email: text(user?.get('email')),
      requestedAt: millis(doc.get('driverRequestedAt')),
      driverStatus,
      driverReason: driver?.exists ? text(driver.get('verificationReason')) : null,
      vehicle:
        vehicle?.exists && vehicleStatus !== null
          ? {
              type: text(vehicle.get('type')) ?? '',
              make: text(vehicle.get('make')) ?? '',
              model: text(vehicle.get('model')) ?? '',
              plateNumber: text(vehicle.get('plateNumber')) ?? '',
              seatCapacity: typeof seats === 'number' ? seats : null,
              status: vehicleStatus,
              reason: text(vehicle.get('verificationReason')),
            }
          : null,
      needsReview:
        vehicleStatus !== null && (driverStatus === 'PENDING' || vehicleStatus === 'PENDING'),
    };
  });
  // What is waiting for a decision first, then the longest-waiting.
  rows.sort(
    (a, b) =>
      Number(b.needsReview) - Number(a.needsReview) || (a.requestedAt ?? 0) - (b.requestedAt ?? 0),
  );
  return { rows };
}

/**
 * Approves an employee as a driver: verifies the driver profile and the vehicle (the existing
 * review, audited), then grants canDrive in a last transaction that re-reads both. If the employee
 * changed the vehicle in between, nothing is granted and the administrator reviews again. An
 * administrator cannot approve themselves.
 */
export async function approveEmployeeDriver(
  deps: DrivingDeps & { afterReview?: () => Promise<void> },
  caller: CompanyCaller,
  rawInput: unknown,
): Promise<{ status: 'approved' | 'unchanged' }> {
  const { firestore } = deps;
  const companyId = await requireActiveCompanyAdmin(firestore, caller);
  const { uid } = parse(approveEmployeeDriverInputSchema, rawInput, 'The request is not valid.');
  const member = await requireTargetMember(firestore, companyId, caller.uid, uid);

  const [driver, vehicle] = await Promise.all([
    firestore.doc(`drivers/${uid}`).get(),
    firestore.doc(`vehicles/${uid}`).get(),
  ]);
  const alreadyDriving =
    member.get('canDrive') === true &&
    driver.get('verificationStatus') === 'VERIFIED' &&
    vehicle.get('verificationStatus') === 'VERIFIED';
  if (alreadyDriving) return { status: 'unchanged' };

  if (member.get('canDrive') !== true && member.get('driverRequestedAt') == null) {
    throw new HttpsError('failed-precondition', 'This employee has not applied to drive.');
  }
  if (!driver.exists) {
    throw new HttpsError('failed-precondition', 'This employee has not applied to drive.');
  }
  // Checked before anything changes, so a missing vehicle never leaves a half-verified driver.
  if (!vehicle.exists) {
    throw new HttpsError('failed-precondition', 'This employee has not added a vehicle yet.');
  }

  const review = { firestore, push: deps.push };
  await reviewVerification(review, 'DRIVER', caller.uid, { driverId: uid, decision: 'VERIFIED' });
  await reviewVerification(review, 'VEHICLE', caller.uid, { driverId: uid, decision: 'VERIFIED' });
  await deps.afterReview?.();

  const memberRef = firestore.doc(`companies/${companyId}/members/${uid}`);
  await firestore.runTransaction(async (tx) => {
    const [freshMember, freshDriver, freshVehicle, user] = await Promise.all([
      tx.get(memberRef),
      tx.get(firestore.doc(`drivers/${uid}`)),
      tx.get(firestore.doc(`vehicles/${uid}`)),
      tx.get(firestore.doc(`users/${uid}`)),
    ]);
    if (!freshMember.exists || freshMember.get('status') !== 'ACTIVE') {
      throw new HttpsError('not-found', NOT_A_MEMBER);
    }
    if (!user.exists || user.get('status') !== 'ACTIVE') {
      throw new HttpsError('failed-precondition', 'This employee account is not active.');
    }
    if (
      freshDriver.get('verificationStatus') !== 'VERIFIED' ||
      freshVehicle.get('verificationStatus') !== 'VERIFIED'
    ) {
      throw new HttpsError(
        'failed-precondition',
        'The driver profile or the vehicle changed during the review. Review it again.',
      );
    }
    tx.update(memberRef, {
      canDrive: true,
      driverReviewedBy: caller.uid,
      driverReviewedAt: FieldValue.serverTimestamp(),
      driverRequestedAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: 'EMPLOYEE_DRIVER_APPROVED',
      entity: `companies/${companyId}/members/${uid}`,
      previousState: { canDrive: false },
      newState: { canDrive: true },
      reason: 'Approved by a company administrator',
    });
  });
  return { status: 'approved' };
}

/**
 * Rejects the driver profile or the vehicle, with a reason, using the existing review. An approved
 * driver is withdrawn with revokeEmployeeDriver instead.
 */
export async function rejectEmployeeDriver(
  deps: DrivingDeps,
  caller: CompanyCaller,
  rawInput: unknown,
): Promise<{ status: 'rejected' | 'unchanged' }> {
  const { firestore } = deps;
  const companyId = await requireActiveCompanyAdmin(firestore, caller);
  const { uid, target, reason } = parse(
    rejectEmployeeDriverInputSchema,
    rawInput,
    'A rejection needs a reason of at most 500 characters.',
  );
  const member = await requireTargetMember(firestore, companyId, caller.uid, uid);
  if (member.get('canDrive') === true) {
    throw new HttpsError(
      'failed-precondition',
      'This employee is an approved driver. Revoke the capability instead.',
    );
  }
  if (member.get('driverRequestedAt') == null) {
    throw new HttpsError('failed-precondition', 'This employee has not applied to drive.');
  }
  const outcome = await reviewVerification({ firestore, push: deps.push }, target, caller.uid, {
    driverId: uid,
    decision: 'REJECTED',
    reason,
  });
  return { status: outcome.status === 'reviewed' ? 'rejected' : 'unchanged' };
}

/**
 * Withdraws the capability. canDrive goes false FIRST, in its own transaction, so from that moment
 * the person cannot drive whatever the verification says; then the driver profile and the vehicle
 * are rejected with the existing review, which also takes the driver offline and releases matched
 * riders. Safe to repeat: a stopped call is finished by calling again.
 */
export async function revokeEmployeeDriver(
  deps: DrivingDeps,
  caller: CompanyCaller,
  rawInput: unknown,
): Promise<{ status: 'revoked' | 'unchanged' }> {
  const { firestore } = deps;
  const companyId = await requireActiveCompanyAdmin(firestore, caller);
  const { uid, reason } = parse(
    revokeEmployeeDriverInputSchema,
    rawInput,
    'Revoking needs a reason of at most 500 characters.',
  );
  await requireTargetMember(firestore, companyId, caller.uid, uid);

  const memberRef = firestore.doc(`companies/${companyId}/members/${uid}`);
  let changed = await firestore.runTransaction(async (tx) => {
    const member = await tx.get(memberRef);
    if (!member.exists || member.get('canDrive') !== true) return false;
    tx.update(memberRef, {
      canDrive: false,
      driverReviewedBy: null,
      driverReviewedAt: null,
      driverRequestedAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: 'EMPLOYEE_DRIVER_REVOKED',
      entity: `companies/${companyId}/members/${uid}`,
      previousState: { canDrive: true },
      newState: { canDrive: false },
      reason,
    });
    return true;
  });

  for (const target of REVIEW_TARGETS) {
    const collection = target === 'DRIVER' ? 'drivers' : 'vehicles';
    const document = await firestore.doc(`${collection}/${uid}`).get();
    if (!document.exists || document.get('verificationStatus') === 'REJECTED') continue;
    const outcome = await reviewVerification({ firestore, push: deps.push }, target, caller.uid, {
      driverId: uid,
      decision: 'REJECTED',
      reason,
    });
    if (outcome.status === 'reviewed') changed = true;
  }
  return { status: changed ? 'revoked' : 'unchanged' };
}
