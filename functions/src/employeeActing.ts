import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Caller } from './callers.js';
import { RIDE_IN_FLIGHT } from './dataRights.js';

// How a company employee uses the same ride and driving functions as everyone else (module A3a,
// docs/a3-company-matching-design.md, section 4).
//
// Each of those functions checks that its caller's role is PASSENGER or DRIVER. An employee's role is
// EMPLOYEE, so at each entry point this adapter turns an employee into a caller with the role the
// function expects, with their company attached - after reading the membership document, never the
// token alone. Nothing downstream is rewritten: the same code runs, and only the company is new.
//
// A CONSUMER (any role other than EMPLOYEE) is returned exactly as it came in, with no reads and no
// new code reached, so consumer calls behave as they did before companies existed.

export type ActingRole = 'PASSENGER' | 'DRIVER';

/**
 * What the action is, which decides how much is checked:
 * - start: begins an activity (asking for a ride, declaring a destination, going online). A rider and a
 *   driver at the same moment is refused, and a driver needs the full effective capability.
 * - setup: configures an existing journey (seats, detour, origin). A driver needs the full capability.
 * - ongoing: continues something already begun (location updates, trip steps, cancelling). An active
 *   membership, and for a driver the administrator's permission, is enough: revoking or removing a
 *   driver already takes them offline, and this runs on every position update.
 * - offline: going offline. Always allowed, so nobody is ever stuck online.
 */
export type ActingMode = 'start' | 'setup' | 'ongoing' | 'offline';

export interface EmployeeRequestCaller {
  uid: string;
  role: unknown;
  emailVerified: boolean;
  /** The `companyId` claim from the token: a hint only, confirmed against the membership. */
  companyId?: unknown;
}

const ACTIVE_JOURNEY_STATUSES = new Set(['AVAILABLE', 'MATCHING', 'ACTIVE']);

const refuse = (message: string) => new HttpsError('permission-denied', message);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function actingCaller(
  firestore: Firestore,
  caller: EmployeeRequestCaller,
  as: ActingRole,
  mode: ActingMode,
): Promise<Caller> {
  // The consumer path: unchanged, with nothing read and no company attached.
  if (caller.role !== 'EMPLOYEE') {
    return { uid: caller.uid, role: caller.role, emailVerified: caller.emailVerified };
  }
  if (!caller.emailVerified) throw refuse('Verify your email address first.');

  // Going offline needs nothing but being an employee: nobody is ever stuck online.
  if (as === 'DRIVER' && mode === 'offline') {
    return { uid: caller.uid, role: 'DRIVER', emailVerified: true };
  }

  const companyId = text(caller.companyId);
  if (companyId === null) throw refuse('Only an active employee of a company can do this.');

  const needsCapability = as === 'DRIVER' && (mode === 'start' || mode === 'setup');
  // Only what the action needs is read. "ongoing" runs on every position update, so it reads the
  // membership alone.
  const reads = [firestore.doc(`companies/${companyId}/members/${caller.uid}`)];
  if (mode !== 'ongoing') {
    reads.push(firestore.doc(`companies/${companyId}`), firestore.doc(`drivers/${caller.uid}`));
  }
  if (needsCapability) reads.push(firestore.doc(`vehicles/${caller.uid}`));
  const [member, company, driver, vehicle] = await firestore.getAll(...reads);
  if (
    !member?.exists ||
    member.get('status') !== 'ACTIVE' ||
    (mode !== 'ongoing' && (!company?.exists || company.get('status') !== 'ACTIVE'))
  ) {
    throw refuse('Only an active employee of a company can do this.');
  }

  if (as === 'DRIVER') {
    if (member.get('canDrive') !== true) {
      throw refuse('You have not been approved to drive for your company.');
    }
    if (needsCapability) {
      // The administrator's permission AND a currently verified driver profile and vehicle.
      if (
        driver?.get('verificationStatus') !== 'VERIFIED' ||
        vehicle?.get('verificationStatus') !== 'VERIFIED'
      ) {
        throw refuse(
          'Your driver profile and vehicle need to be verified again before you can drive.',
        );
      }
    }
    if (mode === 'start') await refuseIfRiding(firestore, caller.uid);
  } else if (mode === 'start') {
    await refuseIfDriving(firestore, caller.uid, driver);
  }

  return { uid: caller.uid, role: as, emailVerified: true, companyId };
}

/** A driver cannot also have a ride request open. */
async function refuseIfRiding(firestore: Firestore, uid: string): Promise<void> {
  const user = await firestore.doc(`users/${uid}`).get();
  const tripId = text(user.get('currentTripRequestId'));
  if (tripId === null) return;
  const trip = await firestore.doc(`tripRequests/${tripId}`).get();
  const status: unknown = trip.get('status');
  if (
    trip.exists &&
    trip.get('passengerId') === uid &&
    typeof status === 'string' &&
    RIDE_IN_FLIGHT.has(status)
  ) {
    throw new HttpsError(
      'failed-precondition',
      'Finish or cancel your ride request before you drive.',
    );
  }
}

/** A rider cannot also be online as a driver or have a journey open. */
async function refuseIfDriving(
  firestore: Firestore,
  uid: string,
  driver: DocumentSnapshot | undefined,
): Promise<void> {
  if (!driver?.exists) return;
  if (driver.get('availabilityStatus') === 'ONLINE') {
    throw new HttpsError('failed-precondition', 'Go offline before you ask for a ride.');
  }
  const journeyId = text(driver.get('currentJourneyId'));
  if (journeyId === null) return;
  const journey = await firestore.doc(`driverJourneys/${journeyId}`).get();
  const status: unknown = journey.get('status');
  if (journey.exists && typeof status === 'string' && ACTIVE_JOURNEY_STATUSES.has(status)) {
    throw new HttpsError('failed-precondition', 'End your journey before you ask for a ride.');
  }
}
