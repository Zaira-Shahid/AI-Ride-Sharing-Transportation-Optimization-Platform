import type { Auth } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { enforceCallRateLimit } from './callLimits.js';
import type { Caller } from './callers.js';
import {
  DELETED_PASSENGER_NAME,
  EXPORT_RECORD_CAP,
  RIDE_IN_FLIGHT,
  defaultDeletionLog,
  deleteInChunks,
  deleteMyAccountInputSchema,
  iso,
  num,
  placeOf,
  str,
  updateInChunks,
  type DeletionLog,
} from './dataRights.js';

// Employee data rights (module A2c, docs/a2c-employee-data-rights-design.md): a company employee
// downloads their own data and deletes their own account. The third version of functions/src/
// dataRights.ts (passengers) and driverDataRights.ts (drivers), reusing their helpers.
//
// WHO: a verified email whose account is an employee. That is the token's role, or - for someone
// removed from their company, whose claims were cleared and whose token therefore has no role - the
// role on their own profile. Either way the handlers only ever touch the caller's own data.
//
// EXPORT: an explicit allow-list of what the person gave or generated, never a raw dump. Nothing about
// any other member, the company's other data, or invitations written to other people.
//
// DELETION, in an order that leaves something safe to retry (every step tolerates having already
// happened):
//   1. refuse while anything is in flight (an online driver, an active journey, an unfinished ride, a
//      payment hold or an open dispute), or while they are the last administrator of a company that
//      still has other active members;
//   2. take them out of other people's trip records (as a driver) and anonymize their own (as a rider);
//   3. clear the places and the link from their journeys and route plans, and unlink any earning or
//      receipt (company rides carry none today; this keeps it true if that changes);
//   4. strip their membership to non-identifying fields (kept under the uid, as audit entries are, so
//      past rides still count as numbers) and clear the email on the invitation they accepted; close the
//      company if they were its only active member;
//   5. delete their notifications, vehicle, driver profile and user profile;
//   6. delete the sign-in account.
// There is no payment step: company rides are free, so no Stripe customer exists.
//
// Not removed, on purpose: audit entries (they hold the uid as actor), the per-account rate-limit
// counters, the company's own documents, and invitations the person created for others.

const ACTIVE_JOURNEY_STATUSES = new Set(['AVAILABLE', 'MATCHING', 'ACTIVE']);
const EXPORT_LIMIT = { windowMs: 60 * 60_000, maxCalls: 5 };
const DELETE_LIMIT = { windowMs: 60 * 60_000, maxCalls: 3 };

export const COMPANY_CLOSED_REASON = 'Closed by its last member';

/**
 * Whether this caller is an employee for the purposes of data rights: the token says so, or the token
 * carries no role at all (someone removed from their company) and their own profile says so. A
 * consumer's token always carries its role, so this never captures a consumer.
 */
export async function isEmployeeAccount(firestore: Firestore, caller: Caller): Promise<boolean> {
  if (caller.role === 'EMPLOYEE') return true;
  if (caller.role !== undefined && caller.role !== null && caller.role !== '') return false;
  const profile = await firestore.doc(`users/${caller.uid}`).get();
  return profile.exists && profile.get('role') === 'EMPLOYEE';
}

async function requireEmployee(firestore: Firestore, caller: Caller) {
  if (!caller.emailVerified || !(await isEmployeeAccount(firestore, caller))) {
    throw new HttpsError('permission-denied', 'Only an employee can do this.');
  }
  return firestore.doc(`users/${caller.uid}`).get();
}

export interface EmployeeDataExport {
  exportedAt: string;
  profile: {
    name: string | null;
    email: string | null;
    phone: string | null;
    status: string | null;
    createdAt: string | null;
  };
  company: {
    name: string | null;
    companyRole: string | null;
    membershipStatus: string | null;
    joinedAt: string | null;
  } | null;
  driving: {
    applied: boolean;
    canDrive: boolean;
    driverVerificationStatus: string | null;
    driverVerificationReason: string | null;
    vehicle: {
      type: string | null;
      make: string | null;
      model: string | null;
      plateNumber: string | null;
      seatCapacity: number | null;
      verificationStatus: string | null;
    } | null;
  };
  invitation: { status: string | null; acceptedAt: string | null; expiresAt: string | null } | null;
  /** Company rides they took: their own places and times. */
  ridesTaken: Record<string, unknown>[];
  /** Company rides they drove: status, times and fare only, never who rode. */
  ridesDriven: Record<string, unknown>[];
  journeys: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  truncated: boolean;
}

export async function exportEmployeeData(
  deps: { firestore: Firestore; now?: () => number },
  caller: Caller,
): Promise<EmployeeDataExport> {
  const { firestore } = deps;
  const user = await requireEmployee(firestore, caller);
  const now = (deps.now ?? Date.now)();
  await enforceCallRateLimit(firestore, 'exportMyData', caller.uid, now, EXPORT_LIMIT);

  const companyId = str(user.get('companyId'));
  const cap = EXPORT_RECORD_CAP + 1;
  const [company, member, driver, vehicle, taken, driven, journeys, notifications, invitations] =
    await Promise.all([
      companyId ? firestore.doc(`companies/${companyId}`).get() : undefined,
      companyId ? firestore.doc(`companies/${companyId}/members/${caller.uid}`).get() : undefined,
      firestore.doc(`drivers/${caller.uid}`).get(),
      firestore.doc(`vehicles/${caller.uid}`).get(),
      firestore.collection('tripRequests').where('passengerId', '==', caller.uid).limit(cap).get(),
      firestore
        .collection('tripRequests')
        .where('matchedDriverId', '==', caller.uid)
        .limit(cap)
        .get(),
      firestore.collection('driverJourneys').where('driverId', '==', caller.uid).limit(cap).get(),
      firestore.collection('notifications').where('recipientId', '==', caller.uid).limit(cap).get(),
      firestore
        .collection('companyInvitations')
        .where('acceptedBy', '==', caller.uid)
        .limit(1)
        .get(),
    ]);
  const truncated = [taken, driven, journeys, notifications].some(
    (snapshot) => snapshot.size > EXPORT_RECORD_CAP,
  );

  await firestore
    .collection('auditLogs')
    .doc()
    .create({
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: 'ACCOUNT_DATA_EXPORTED',
      entity: `users/${caller.uid}`,
      previousState: null,
      newState: null,
      reason: 'Employee downloaded their own data',
    });

  const invitation = invitations.docs[0];
  return {
    exportedAt: new Date(now).toISOString(),
    profile: {
      name: str(user.get('name')),
      email: str(user.get('email')),
      phone: str(user.get('phone')),
      status: str(user.get('status')),
      createdAt: iso(user.get('createdAt')),
    },
    company:
      company?.exists && member?.exists
        ? {
            name: str(company.get('name')),
            companyRole: str(member.get('companyRole')),
            membershipStatus: str(member.get('status')),
            joinedAt: iso(member.get('joinedAt')),
          }
        : null,
    driving: {
      applied: driver.exists,
      canDrive: member?.get('canDrive') === true,
      driverVerificationStatus: driver.exists ? str(driver.get('verificationStatus')) : null,
      driverVerificationReason: driver.exists ? str(driver.get('verificationReason')) : null,
      vehicle: vehicle.exists
        ? {
            type: str(vehicle.get('type')),
            make: str(vehicle.get('make')),
            model: str(vehicle.get('model')),
            plateNumber: str(vehicle.get('plateNumber')),
            seatCapacity: num(vehicle.get('seatCapacity')),
            verificationStatus: str(vehicle.get('verificationStatus')),
          }
        : null,
    },
    invitation: invitation
      ? {
          status: str(invitation.get('status')),
          acceptedAt: iso(invitation.get('acceptedAt')),
          expiresAt: iso(invitation.get('expiresAt')),
        }
      : null,
    ridesTaken: taken.docs.slice(0, EXPORT_RECORD_CAP).map((doc) => ({
      tripId: doc.id,
      status: str(doc.get('status')),
      requestedAt: iso(doc.get('requestedAt')),
      endedAt: iso(doc.get('endedAt')),
      // Null once the retention sweep has cleared them.
      origin: placeOf(doc.get('origin')),
      destination: placeOf(doc.get('destination')),
      sharedRide: doc.get('sharedRide') === true,
    })),
    ridesDriven: driven.docs.slice(0, EXPORT_RECORD_CAP).map((doc) => ({
      tripId: doc.id,
      status: str(doc.get('status')),
      requestedAt: iso(doc.get('requestedAt')),
      endedAt: iso(doc.get('endedAt')),
      sharedRide: doc.get('sharedRide') === true,
    })),
    journeys: journeys.docs.slice(0, EXPORT_RECORD_CAP).map((doc) => ({
      journeyId: doc.id,
      status: str(doc.get('status')),
      origin: placeOf(doc.get('origin')),
      destination: placeOf(doc.get('destination')),
      departureTime: iso(doc.get('departureTime')),
      passengersMatched: Array.isArray(doc.get('matchedTripRequestIds'))
        ? (doc.get('matchedTripRequestIds') as unknown[]).length
        : 0,
      createdAt: iso(doc.get('createdAt')),
    })),
    notifications: notifications.docs.slice(0, EXPORT_RECORD_CAP).map((doc) => ({
      type: str(doc.get('type')),
      message: str(doc.get('message')),
      createdAt: iso(doc.get('createdAt')),
    })),
    truncated,
  };
}

export async function deleteEmployeeAccount(
  deps: {
    firestore: Firestore;
    auth: Pick<Auth, 'deleteUser'>;
    now?: () => number;
    /** Where the deletion is recorded outside Firestore; Cloud Logging unless a test passes its own. */
    log?: DeletionLog;
  },
  caller: Caller,
  rawInput: unknown,
): Promise<{ status: 'deleted' }> {
  const { firestore, auth } = deps;
  const user = await requireEmployee(firestore, caller);
  await enforceCallRateLimit(
    firestore,
    'deleteMyAccount',
    caller.uid,
    (deps.now ?? Date.now)(),
    DELETE_LIMIT,
  );

  if (!deleteMyAccountInputSchema.safeParse(rawInput).success) {
    throw new HttpsError('invalid-argument', 'Confirm the deletion to continue.');
  }

  // A repeat after the profile is gone has no company to read; everything below tolerates that.
  const companyId = str(user.get('companyId'));
  const userRef = firestore.doc(`users/${caller.uid}`);
  const memberRef = companyId
    ? firestore.doc(`companies/${companyId}/members/${caller.uid}`)
    : null;
  const [member, driver, journeys, taken, driven] = await Promise.all([
    memberRef?.get(),
    firestore.doc(`drivers/${caller.uid}`).get(),
    firestore.collection('driverJourneys').where('driverId', '==', caller.uid).get(),
    firestore.collection('tripRequests').where('passengerId', '==', caller.uid).get(),
    firestore.collection('tripRequests').where('matchedDriverId', '==', caller.uid).get(),
  ]);

  // 1. Refuse while anything is still in flight: finishing it is the person's call.
  if (driver.exists && driver.get('availabilityStatus') !== 'OFFLINE') {
    throw new HttpsError('failed-precondition', 'Go offline before deleting your account.');
  }
  if (journeys.docs.some((doc) => ACTIVE_JOURNEY_STATUSES.has(doc.get('status') as string))) {
    throw new HttpsError(
      'failed-precondition',
      'Finish or end your current journey before deleting your account.',
    );
  }
  for (const doc of [...taken.docs, ...driven.docs]) {
    const status: unknown = doc.get('status');
    if (typeof status === 'string' && RIDE_IN_FLIGHT.has(status)) {
      throw new HttpsError(
        'failed-precondition',
        'Finish or cancel your current ride before deleting your account.',
      );
    }
    if (doc.get('paymentStatus') === 'AUTHORIZED') {
      throw new HttpsError(
        'failed-precondition',
        'A payment on one of your rides is still being processed. Try again once it has finished.',
      );
    }
    if (doc.get('paymentStatus') === 'DISPUTED' && doc.get('disputeReviewed') !== true) {
      throw new HttpsError(
        'failed-precondition',
        'A payment dispute on one of your rides is still open. Try again once it is resolved.',
      );
    }
  }

  // The last administrator may not leave a company that still has other active members, and the only
  // active member closes it. Someone already removed from the company is neither.
  let closesCompany = false;
  if (companyId && member?.exists && member.get('status') === 'ACTIVE') {
    const active = await firestore
      .collection(`companies/${companyId}/members`)
      .where('status', '==', 'ACTIVE')
      .get();
    const others = active.docs.filter((doc) => doc.id !== caller.uid);
    const isAdmin = member.get('companyRole') === 'COMPANY_ADMIN';
    const otherAdmin = others.some((doc) => doc.get('companyRole') === 'COMPANY_ADMIN');
    if (isAdmin && !otherAdmin && others.length > 0) {
      throw new HttpsError(
        'failed-precondition',
        'You are the last administrator of your company. Make someone else an administrator first.',
      );
    }
    closesCompany = others.length === 0;
  }

  // 2. Take them out of other people's trip records, and anonymize their own.
  await updateInChunks(
    firestore,
    driven.docs.map((doc) => doc.ref),
    {
      matchedDriverId: null,
      driverName: null,
      vehicleType: null,
      vehicleMake: null,
      vehicleModel: null,
      vehiclePlateNumber: null,
      driverLocation: null,
    },
  );
  await updateInChunks(
    firestore,
    taken.docs.map((doc) => doc.ref),
    {
      passengerId: null,
      passengerName: DELETED_PASSENGER_NAME,
      origin: null,
      destination: null,
      driverLocation: null,
      placesCleared: true,
    },
  );

  // 3. Journeys and route plans lose their places and their link; any earning or receipt is unlinked.
  const [plans, earnings, receipts] = await Promise.all([
    firestore.collection('journeyPlans').where('driverId', '==', caller.uid).get(),
    firestore.collection('driverEarnings').where('driverId', '==', caller.uid).get(),
    firestore.collection('receipts').where('passengerId', '==', caller.uid).get(),
  ]);
  await updateInChunks(
    firestore,
    journeys.docs.map((doc) => doc.ref),
    {
      driverId: null,
      vehicleId: null,
      origin: null,
      destination: null,
      currentLocation: null,
      placesCleared: true,
    },
  );
  await updateInChunks(
    firestore,
    plans.docs.map((doc) => doc.ref),
    { driverId: null },
  );
  await updateInChunks(
    firestore,
    earnings.docs.map((doc) => doc.ref),
    { driverId: null },
  );
  await updateInChunks(
    firestore,
    receipts.docs.map((doc) => doc.ref),
    { passengerId: null },
  );

  // 4. The membership is kept, stripped; the accepted invitation loses the email; the company closes
  //    if this was its only active member.
  if (memberRef && member?.exists) {
    await memberRef.update({
      status: 'REMOVED',
      canDrive: false,
      driverReviewedBy: null,
      driverReviewedAt: null,
      driverRequestedAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  const invitations = await firestore
    .collection('companyInvitations')
    .where('acceptedBy', '==', caller.uid)
    .get();
  await updateInChunks(
    firestore,
    invitations.docs.map((doc) => doc.ref),
    { email: null },
  );
  if (companyId && closesCompany) {
    const company = await firestore.doc(`companies/${companyId}`).get();
    if (company.exists && company.get('status') !== 'SUSPENDED') {
      await company.ref.update({
        status: 'SUSPENDED',
        statusReason: COMPANY_CLOSED_REASON,
        updatedAt: FieldValue.serverTimestamp(),
      });
      await firestore
        .collection('auditLogs')
        .doc()
        .create({
          timestamp: FieldValue.serverTimestamp(),
          actor: caller.uid,
          action: 'COMPANY_CLOSED',
          entity: `companies/${companyId}`,
          previousState: { status: 'ACTIVE' },
          newState: { status: 'SUSPENDED' },
          reason: COMPANY_CLOSED_REASON,
        });
    }
  }

  // 5. Notifications, vehicle (which frees its plate), driver profile and user profile.
  const notifications = await firestore
    .collection('notifications')
    .where('recipientId', '==', caller.uid)
    .get();
  await deleteInChunks(
    firestore,
    notifications.docs.map((doc) => doc.ref),
  );
  await firestore.doc(`vehicles/${caller.uid}`).delete();
  await firestore.doc(`drivers/${caller.uid}`).delete();
  await userRef.delete();

  await firestore
    .collection('auditLogs')
    .doc()
    .create({
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: 'ACCOUNT_DELETED',
      entity: `users/${caller.uid}`,
      previousState: null,
      newState: null,
      reason: 'Employee deleted their own account',
    });
  (deps.log ?? defaultDeletionLog)('ACCOUNT_DELETED', {
    event: 'ACCOUNT_DELETED',
    uid: caller.uid,
    role: 'EMPLOYEE',
  });

  // 6. The sign-in account itself. A missing one is already done.
  try {
    await auth.deleteUser(caller.uid);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'auth/user-not-found') throw error;
  }

  return { status: 'deleted' };
}
