import type { Auth } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { enforceCallRateLimit } from './callLimits.js';
import { requireVerifiedDriver, type DriverCaller } from './callers.js';
import {
  EXPORT_RECORD_CAP,
  RIDE_IN_FLIGHT,
  deleteInChunks,
  deleteMyAccountInputSchema,
  iso,
  num,
  placeOf,
  str,
  updateInChunks,
} from './dataRights.js';

// Phase 14 (Privacy compliance, spec section 56): a driver downloads their own data and deletes their
// own account, the second half of functions/src/dataRights.ts (the passenger's), which this reuses
// for everything the two share. The same two callables serve both roles (index.ts picks by the
// caller's role), so the app and its client wrappers are the same for both.
//
// EXPORT: an explicit allow-list of what the driver gave or earned, never a raw dump - so a
// passenger's name, places and payment details are never in it. A trip they drove shows its status,
// times and fare only. Capped per kind, with `truncated` when that cut something off.
//
// DELETION, in an order that leaves something safe to retry (every step tolerates having already
// happened):
//   1. refuse while the driver is online, has a journey that is available, matching or active, drives
//      a ride that is still in flight, has a payment hold outstanding on a ride they drove, or has an
//      unreviewed dispute on one;
//   2. take the driver out of every passenger's trip record (name, vehicle, plate, position and the
//      link to them), keeping the trip itself: its fare and payment fields, and the passenger's own
//      side, are untouched;
//   3. anonymize the earnings ledger (kept: financial records, the same decision as the passenger's
//      receipts), and clear the places and the link from their journeys and route plans;
//   4. delete their notifications, vehicle, driver profile and user profile;
//   5. delete the sign-in account.
// There is no Stripe step: no driver payout account exists (driver payouts are deliberately not built),
// so nothing outside Firestore holds the driver's details.
//
// Not removed, on purpose: audit entries keep the account's uid as the actor, and the per-account rate
// limit counters hold only a uid and a count. Freeing the vehicle document also frees its plate for
// another driver (uniqueness is a query on the vehicles themselves).

const ACTIVE_JOURNEY_STATUSES = new Set(['AVAILABLE', 'MATCHING', 'ACTIVE']);

export interface DriverDataExport {
  exportedAt: string;
  profile: {
    name: string | null;
    email: string | null;
    phone: string | null;
    status: string | null;
    createdAt: string | null;
  };
  driver: {
    verificationStatus: string | null;
    verificationReason: string | null;
    availabilityStatus: string | null;
    rating: number | null;
    totalTrips: number | null;
  } | null;
  vehicle: {
    type: string | null;
    make: string | null;
    model: string | null;
    plateNumber: string | null;
    seatCapacity: number | null;
    verificationStatus: string | null;
  } | null;
  journeys: Record<string, unknown>[];
  earnings: Record<string, unknown>[];
  trips: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  truncated: boolean;
}

export async function exportDriverData(
  deps: { firestore: Firestore; now?: () => number },
  caller: DriverCaller,
): Promise<DriverDataExport> {
  requireVerifiedDriver(caller);
  const { firestore } = deps;
  const now = (deps.now ?? Date.now)();
  await enforceCallRateLimit(firestore, 'exportMyData', caller.uid, now, {
    windowMs: 60 * 60_000,
    maxCalls: 5,
  });

  const cap = EXPORT_RECORD_CAP + 1;
  const [user, driver, vehicle, journeys, earnings, trips, notifications] = await Promise.all([
    firestore.collection('users').doc(caller.uid).get(),
    firestore.collection('drivers').doc(caller.uid).get(),
    firestore.collection('vehicles').doc(caller.uid).get(),
    firestore.collection('driverJourneys').where('driverId', '==', caller.uid).limit(cap).get(),
    firestore.collection('driverEarnings').where('driverId', '==', caller.uid).limit(cap).get(),
    firestore
      .collection('tripRequests')
      .where('matchedDriverId', '==', caller.uid)
      .limit(cap)
      .get(),
    firestore.collection('notifications').where('recipientId', '==', caller.uid).limit(cap).get(),
  ]);
  const truncated = [journeys, earnings, trips, notifications].some(
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
      reason: 'Driver downloaded their own data',
    });

  return {
    exportedAt: new Date(now).toISOString(),
    profile: {
      name: str(user.get('name')),
      email: str(user.get('email')),
      phone: str(user.get('phone')),
      status: str(user.get('status')),
      createdAt: iso(user.get('createdAt')),
    },
    driver: driver.exists
      ? {
          verificationStatus: str(driver.get('verificationStatus')),
          verificationReason: str(driver.get('verificationReason')),
          availabilityStatus: str(driver.get('availabilityStatus')),
          rating: num(driver.get('rating')),
          totalTrips: num(driver.get('totalTrips')),
        }
      : null,
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
    journeys: journeys.docs.slice(0, EXPORT_RECORD_CAP).map((doc) => ({
      journeyId: doc.id,
      status: str(doc.get('status')),
      // Null once cleared (a deleted account's journeys are, and any a later retention rule clears).
      origin: placeOf(doc.get('origin')),
      destination: placeOf(doc.get('destination')),
      departureTime: iso(doc.get('departureTime')),
      passengersMatched: Array.isArray(doc.get('matchedTripRequestIds'))
        ? (doc.get('matchedTripRequestIds') as unknown[]).length
        : 0,
      createdAt: iso(doc.get('createdAt')),
    })),
    earnings: earnings.docs.slice(0, EXPORT_RECORD_CAP).map((doc) => ({
      tripId: str(doc.get('tripId')),
      amountMinorUnits: num(doc.get('amountMinorUnits')),
      currency: str(doc.get('currency')),
      createdAt: iso(doc.get('createdAt')),
    })),
    // What the driver did, never who rode: no passenger name, place or payment detail.
    trips: trips.docs.slice(0, EXPORT_RECORD_CAP).map((doc) => ({
      tripId: doc.id,
      status: str(doc.get('status')),
      requestedAt: iso(doc.get('requestedAt')),
      endedAt: iso(doc.get('endedAt')),
      sharedRide: doc.get('sharedRide') === true,
      finalFareMinorUnits: num(doc.get('finalFareMinorUnits')),
    })),
    notifications: notifications.docs.slice(0, EXPORT_RECORD_CAP).map((doc) => ({
      type: str(doc.get('type')),
      message: str(doc.get('message')),
      createdAt: iso(doc.get('createdAt')),
    })),
    truncated,
  };
}

export async function deleteDriverAccount(
  deps: {
    firestore: Firestore;
    auth: Pick<Auth, 'deleteUser'>;
    now?: () => number;
  },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<{ status: 'deleted' }> {
  requireVerifiedDriver(caller);
  const { firestore, auth } = deps;
  await enforceCallRateLimit(firestore, 'deleteMyAccount', caller.uid, (deps.now ?? Date.now)(), {
    windowMs: 60 * 60_000,
    maxCalls: 3,
  });

  if (!deleteMyAccountInputSchema.safeParse(rawInput).success) {
    throw new HttpsError('invalid-argument', 'Confirm the deletion to continue.');
  }

  const userRef = firestore.collection('users').doc(caller.uid);
  const driverRef = firestore.collection('drivers').doc(caller.uid);
  const vehicleRef = firestore.collection('vehicles').doc(caller.uid);
  const [driver, journeys, trips] = await Promise.all([
    driverRef.get(),
    firestore.collection('driverJourneys').where('driverId', '==', caller.uid).get(),
    firestore.collection('tripRequests').where('matchedDriverId', '==', caller.uid).get(),
  ]);

  // 1. Refuse while anything is still in flight: finishing it is the driver's call.
  if (driver.exists && driver.get('availabilityStatus') !== 'OFFLINE') {
    throw new HttpsError('failed-precondition', 'Go offline before deleting your account.');
  }
  if (journeys.docs.some((doc) => ACTIVE_JOURNEY_STATUSES.has(doc.get('status') as string))) {
    throw new HttpsError(
      'failed-precondition',
      'Finish or end your current journey before deleting your account.',
    );
  }
  for (const doc of trips.docs) {
    const status: unknown = doc.get('status');
    if (typeof status === 'string' && RIDE_IN_FLIGHT.has(status)) {
      throw new HttpsError(
        'failed-precondition',
        'Finish your current ride before deleting your account.',
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

  // 2. Take the driver out of the passengers' trip records. The trip, its fare and payment fields and
  //    the passenger's own side stay exactly as they are.
  await updateInChunks(
    firestore,
    trips.docs.map((doc) => doc.ref),
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

  // 3. The earnings ledger (kept, unlinked) and the journeys and route plans (places and link removed).
  const [earnings, plans] = await Promise.all([
    firestore.collection('driverEarnings').where('driverId', '==', caller.uid).get(),
    firestore.collection('journeyPlans').where('driverId', '==', caller.uid).get(),
  ]);
  await updateInChunks(
    firestore,
    earnings.docs.map((doc) => doc.ref),
    { driverId: null },
  );
  await updateInChunks(
    firestore,
    journeys.docs.map((doc) => doc.ref),
    { driverId: null, vehicleId: null, origin: null, destination: null, currentLocation: null },
  );
  await updateInChunks(
    firestore,
    plans.docs.map((doc) => doc.ref),
    { driverId: null },
  );

  // 4. Notifications, vehicle, driver profile and user profile. Deleting the vehicle also frees its
  //    plate for another driver.
  const notifications = await firestore
    .collection('notifications')
    .where('recipientId', '==', caller.uid)
    .get();
  await deleteInChunks(
    firestore,
    notifications.docs.map((doc) => doc.ref),
  );
  await vehicleRef.delete();
  await driverRef.delete();
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
      reason: 'Driver deleted their own account',
    });

  // 5. The sign-in account itself. A missing one is already done.
  try {
    await auth.deleteUser(caller.uid);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'auth/user-not-found') throw error;
  }

  return { status: 'deleted' };
}
