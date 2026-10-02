import type { Auth } from 'firebase-admin/auth';
import {
  FieldValue,
  Timestamp,
  type DocumentReference,
  type Firestore,
} from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { enforceCallRateLimit } from './callLimits.js';
import { requireVerifiedPassenger, type PassengerCaller } from './callers.js';
import type { StripeProvider } from './stripeProvider.js';

// Phase 14 (Privacy compliance, spec section 56 "deletion workflows" and the data protection
// requirement): a passenger can download their own data and delete their own account. Passengers only
// in this pass - a driver's deletion also touches payouts, the earnings ledger and the vehicle, a
// separate decision.
//
// EXPORT (exportMyData): an explicit allow-list of what the passenger gave or was given, never a raw
// document dump - so another person's data (the driver's name, plate, position) and internal
// bookkeeping (platform fee, tokens, Stripe ids) are never in it. Capped per collection; `truncated`
// says when a cap cut something off. Writes nothing but an audit entry that an export happened.
//
// DELETION (deleteMyAccount), in this order so a failure part-way leaves something safe to retry:
//   1. refuse while a ride is open, a payment hold is outstanding, or a dispute is unreviewed;
//   2. delete the Stripe Customer (the saved card reference) - aborts everything if Stripe fails;
//   3. anonymize every one of their trip requests and receipts: the link to the person is removed
//      (passengerId null, name replaced, exact places and last driver position cleared) but the
//      record stays, because fares, refunds and disputes are financial records that have to be kept
//      (the decision made with the user: anonymize, not delete);
//   4. delete their notifications and their profile document;
//   5. delete the sign-in account itself.
// Every step tolerates having already happened, so calling it again finishes a half-done deletion.
//
// What is deliberately NOT removed: audit entries keep the account's uid as the actor (an audit trail
// that can be edited is not one; the uid alone no longer identifies anyone once the profile is gone),
// and the per-account rate limit counters (a uid and a count). Driver journey plans that hold a
// matched passenger's pickup point are the separate journey retention decision, not covered here.

const EXPORT_LIMIT = { windowMs: 60 * 60_000, maxCalls: 5 };
const DELETE_LIMIT = { windowMs: 60 * 60_000, maxCalls: 3 };

/** At most this many of each kind of record go into one export. */
export const EXPORT_RECORD_CAP = 500;
const WRITE_CHUNK = 400;

/** Written over the name on an anonymized trip request. */
export const DELETED_PASSENGER_NAME = 'Deleted passenger';

export const deleteMyAccountInputSchema = z.object({ confirm: z.literal('DELETE') });

export type DeleteMyAccountResult = { status: 'deleted' };

export const iso = (value: unknown): string | null =>
  value instanceof Timestamp ? value.toDate().toISOString() : null;
export const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
export const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function placeOf(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const place = value as Record<string, unknown>;
  return {
    latitude: num(place.latitude),
    longitude: num(place.longitude),
    formattedAddress: str(place.formattedAddress),
  };
}

export interface PassengerDataExport {
  exportedAt: string;
  profile: {
    name: string | null;
    email: string | null;
    phone: string | null;
    status: string | null;
    createdAt: string | null;
    hasSavedPaymentMethod: boolean;
  };
  trips: Record<string, unknown>[];
  receipts: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  truncated: boolean;
}

export async function exportMyData(
  deps: { firestore: Firestore; now?: () => number },
  caller: PassengerCaller,
): Promise<PassengerDataExport> {
  requireVerifiedPassenger(caller);
  const { firestore } = deps;
  const now = (deps.now ?? Date.now)();
  await enforceCallRateLimit(firestore, 'exportMyData', caller.uid, now, EXPORT_LIMIT);

  const cap = EXPORT_RECORD_CAP + 1;
  const [user, trips, receipts, notifications] = await Promise.all([
    firestore.collection('users').doc(caller.uid).get(),
    firestore.collection('tripRequests').where('passengerId', '==', caller.uid).limit(cap).get(),
    firestore.collection('receipts').where('passengerId', '==', caller.uid).limit(cap).get(),
    firestore.collection('notifications').where('recipientId', '==', caller.uid).limit(cap).get(),
  ]);
  const truncated = [trips, receipts, notifications].some((s) => s.size > EXPORT_RECORD_CAP);

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
      reason: 'Passenger downloaded their own data',
    });

  return {
    exportedAt: new Date(now).toISOString(),
    profile: {
      name: str(user.get('name')),
      email: str(user.get('email')),
      phone: str(user.get('phone')),
      status: str(user.get('status')),
      createdAt: iso(user.get('createdAt')),
      hasSavedPaymentMethod: Boolean(user.get('paymentMethodId')),
    },
    trips: trips.docs.slice(0, EXPORT_RECORD_CAP).map((doc) => ({
      tripId: doc.id,
      status: str(doc.get('status')),
      requestedAt: iso(doc.get('requestedAt')),
      endedAt: iso(doc.get('endedAt')),
      // Null once the 30-day retention sweep has cleared them (tripRetention.ts).
      origin: placeOf(doc.get('origin')),
      destination: placeOf(doc.get('destination')),
      estimatedDistanceMeters: num(doc.get('estimatedDistance')),
      estimatedDurationSeconds: num(doc.get('estimatedDuration')),
      sharedRide: doc.get('sharedRide') === true,
      finalFareMinorUnits: num(doc.get('finalFareMinorUnits')),
      refundedAmountMinorUnits: num(doc.get('refundedAmountMinorUnits')),
      paymentStatus: str(doc.get('paymentStatus')),
    })),
    receipts: receipts.docs.slice(0, EXPORT_RECORD_CAP).map((doc) => ({
      tripId: str(doc.get('tripId')),
      currency: str(doc.get('currency')),
      baseFareMinorUnits: num(doc.get('baseFareMinorUnits')),
      distanceTimeComponentMinorUnits: num(doc.get('distanceTimeComponentMinorUnits')),
      sharedRideDiscountMinorUnits: num(doc.get('sharedRideDiscountMinorUnits')),
      totalMinorUnits: num(doc.get('totalMinorUnits')),
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

// A ride in any of these states is still happening or about to: not the moment to delete the account.
export const RIDE_IN_FLIGHT = new Set([
  'REQUESTED',
  'SEARCHING',
  'MATCHED',
  'PICKUP_ASSIGNED',
  'DRIVER_ARRIVING',
  'PICKED_UP',
  'IN_TRANSIT',
  'DROPOFF_APPROACHING',
]);

export async function deleteMyAccount(
  deps: {
    firestore: Firestore;
    auth: Pick<Auth, 'deleteUser'>;
    /** Absent when Stripe is not configured; an account that has a Stripe customer cannot be deleted without it. */
    stripe?: StripeProvider | undefined;
    now?: () => number;
  },
  caller: PassengerCaller,
  rawInput: unknown,
): Promise<DeleteMyAccountResult> {
  requireVerifiedPassenger(caller);
  const { firestore, auth } = deps;
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

  const userRef = firestore.collection('users').doc(caller.uid);
  const [user, trips] = await Promise.all([
    userRef.get(),
    firestore.collection('tripRequests').where('passengerId', '==', caller.uid).get(),
  ]);

  // 1. Refuse while anything is still in flight: finishing or cancelling it is the passenger's call.
  for (const doc of trips.docs) {
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
        'A payment is still being processed. Try again once it has finished.',
      );
    }
    if (doc.get('paymentStatus') === 'DISPUTED' && doc.get('disputeReviewed') !== true) {
      throw new HttpsError(
        'failed-precondition',
        'A payment dispute on one of your rides is still open. Try again once it is resolved.',
      );
    }
  }

  // 2. The Stripe customer. Before anything else is changed, so a failure here loses nothing.
  const stripeCustomerId: unknown = user.get('stripeCustomerId');
  if (typeof stripeCustomerId === 'string' && stripeCustomerId) {
    if (!deps.stripe) {
      throw new HttpsError('unavailable', 'Your account cannot be deleted right now. Try later.');
    }
    const outcome = await deps.stripe.deleteCustomer({ stripeCustomerId });
    if (outcome.status !== 'deleted') {
      throw new HttpsError('unavailable', 'Your account cannot be deleted right now. Try later.');
    }
  }

  // 3. Anonymize the trip requests and receipts (kept: financial records).
  await updateInChunks(
    firestore,
    trips.docs.map((doc) => doc.ref),
    {
      passengerId: null,
      passengerName: DELETED_PASSENGER_NAME,
      origin: null,
      destination: null,
      driverLocation: null,
      placesCleared: true,
    },
  );
  const receipts = await firestore
    .collection('receipts')
    .where('passengerId', '==', caller.uid)
    .get();
  await updateInChunks(
    firestore,
    receipts.docs.map((doc) => doc.ref),
    { passengerId: null },
  );

  // 4. Notifications and the profile.
  const notifications = await firestore
    .collection('notifications')
    .where('recipientId', '==', caller.uid)
    .get();
  await deleteInChunks(
    firestore,
    notifications.docs.map((doc) => doc.ref),
  );
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
      reason: 'Passenger deleted their own account',
    });

  // 5. The sign-in account itself. A missing one is already done.
  try {
    await auth.deleteUser(caller.uid);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'auth/user-not-found') throw error;
  }

  return { status: 'deleted' };
}

export async function updateInChunks(
  firestore: Firestore,
  refs: DocumentReference[],
  fields: Record<string, unknown>,
): Promise<void> {
  for (let i = 0; i < refs.length; i += WRITE_CHUNK) {
    const batch = firestore.batch();
    for (const ref of refs.slice(i, i + WRITE_CHUNK)) batch.update(ref, fields);
    await batch.commit();
  }
}

export async function deleteInChunks(
  firestore: Firestore,
  refs: DocumentReference[],
): Promise<void> {
  for (let i = 0; i < refs.length; i += WRITE_CHUNK) {
    const batch = firestore.batch();
    for (const ref of refs.slice(i, i + WRITE_CHUNK)) batch.delete(ref);
    await batch.commit();
  }
}
