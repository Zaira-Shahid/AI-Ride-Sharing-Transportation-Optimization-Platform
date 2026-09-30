import { FieldPath, FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { isStaffRole } from './roles.js';
import { OPEN_TRIP_STATUSES } from './tripRequests.js';
import type { StaffCaller } from './verification.js';

// Module 11.4 (admin dashboard: trip monitoring). See packages/types/src/tripMonitoring.ts's own
// comment for the scope this was checked and agreed against.

export const TRIP_HISTORY_PAGE_SIZE = 25;
export const TRIP_MONITORING_HISTORY_STATUSES = ['COMPLETED', 'CANCELLED'] as const;
const ACTIVE_TRIPS_LIMIT = 200;

export const listTripHistoryInputSchema = z.object({
  cursor: z
    .object({
      seconds: z.number().int(),
      nanoseconds: z.number().int().min(0).max(999_999_999),
      tripId: z.string().trim().min(1).max(200),
    })
    .nullish(),
});

export const getTripDetailInputSchema = z.object({
  tripId: z.string().trim().min(1).max(200),
});

export interface TripMonitoringRow {
  tripId: string;
  status: string;
  passengerName: string;
  driverName: string | null;
  createdAt: number;
  requestedDepartureTime: number;
  finalFareMinorUnits: number | null;
  estimatedFare: number | null;
  paymentStatus: string | null;
  sharedRide: boolean;
}

export interface ListTripHistoryResult {
  rows: TripMonitoringRow[];
  nextCursor: { seconds: number; nanoseconds: number; tripId: string } | null;
}

export interface TripDetailForStaff extends TripMonitoringRow {
  origin: { latitude: number; longitude: number; formattedAddress: string };
  destination: { latitude: number; longitude: number; formattedAddress: string };
  estimatedDistance: number | null;
  estimatedDuration: number | null;
  vehicleType: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehiclePlateNumber: string | null;
  authorizedAmountMinorUnits: number | null;
  refundedAmountMinorUnits: number | null;
  platformFeeMinorUnits: number | null;
}

function requireStaff(caller: StaffCaller): void {
  if (!isStaffRole(caller.role) || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'You are not allowed to view trips.');
  }
}

export function toMillis(value: unknown): number {
  const timestamp = value as { toMillis?: () => number } | undefined;
  return typeof timestamp?.toMillis === 'function' ? timestamp.toMillis() : 0;
}

export function toRow(tripId: string, data: FirebaseFirestore.DocumentData): TripMonitoringRow {
  return {
    tripId,
    status: typeof data.status === 'string' ? data.status : '',
    passengerName: typeof data.passengerName === 'string' ? data.passengerName : '',
    driverName: typeof data.driverName === 'string' ? data.driverName : null,
    createdAt: toMillis(data.createdAt),
    requestedDepartureTime: toMillis(data.requestedDepartureTime),
    finalFareMinorUnits:
      typeof data.finalFareMinorUnits === 'number' ? data.finalFareMinorUnits : null,
    estimatedFare: typeof data.estimatedFare === 'number' ? data.estimatedFare : null,
    paymentStatus: typeof data.paymentStatus === 'string' ? data.paymentStatus : null,
    sharedRide: data.sharedRide === true,
  };
}

/** Every currently-open trip, newest first - the live view. Not audited (no exact place is here). */
export async function listActiveTripsForStaff(
  deps: { firestore: Firestore },
  caller: StaffCaller,
): Promise<TripMonitoringRow[]> {
  requireStaff(caller);
  const snapshot = await deps.firestore
    .collection('tripRequests')
    .where('status', 'in', [...OPEN_TRIP_STATUSES])
    .orderBy('createdAt', 'desc')
    .limit(ACTIVE_TRIPS_LIMIT)
    .get();
  return snapshot.docs.map((doc) => toRow(doc.id, doc.data()));
}

/** Completed and cancelled trips, newest first, paginated. Not audited (no exact place is here). */
export async function listTripHistoryForStaff(
  deps: { firestore: Firestore },
  caller: StaffCaller,
  rawInput: unknown,
): Promise<ListTripHistoryResult> {
  requireStaff(caller);
  const parsed = listTripHistoryInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The request is not valid.');
  }

  let query = deps.firestore
    .collection('tripRequests')
    .where('status', 'in', [...TRIP_MONITORING_HISTORY_STATUSES])
    .orderBy('createdAt', 'desc')
    .orderBy(FieldPath.documentId(), 'desc')
    .limit(TRIP_HISTORY_PAGE_SIZE);

  const cursor = parsed.data.cursor;
  // The cursor carries the timestamp's full precision: cut to milliseconds, trips created within the
  // same millisecond as the last one on a page could be skipped on the next page.
  if (cursor) {
    query = query.startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.tripId);
  }

  const snapshot = await query.get();
  const rows = snapshot.docs.map((doc) => toRow(doc.id, doc.data()));
  const last = snapshot.docs.at(-1);
  const lastTimestamp = last?.get('createdAt') as Timestamp | undefined;
  const nextCursor =
    rows.length === TRIP_HISTORY_PAGE_SIZE && last && lastTimestamp
      ? { seconds: lastTimestamp.seconds, nanoseconds: lastTimestamp.nanoseconds, tripId: last.id }
      : null;
  return { rows, nextCursor };
}

/**
 * One trip's full detail, including its exact places - the only path staff have to them. Every call
 * audits a TRIP_VIEWED_BY_STAFF entry naming the trip, never the place (docs/security.md: "the audit
 * trail names no place").
 */
export async function getTripDetailForStaff(
  deps: { firestore: Firestore },
  caller: StaffCaller,
  rawInput: unknown,
): Promise<TripDetailForStaff> {
  requireStaff(caller);
  const parsed = getTripDetailInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The request is not valid.');
  }
  const { tripId } = parsed.data;

  const { firestore } = deps;
  const snapshot = await firestore.collection('tripRequests').doc(tripId).get();
  if (!snapshot.exists) {
    throw new HttpsError('not-found', 'There is no trip with that ID.');
  }
  const data = snapshot.data()!;

  await firestore
    .collection('auditLogs')
    .doc()
    .set({
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: 'TRIP_VIEWED_BY_STAFF',
      entity: `tripRequests/${tripId}`,
      previousState: null,
      newState: null,
      reason: 'Staff opened trip detail',
    });

  const place = (value: unknown) => {
    const stored = value as
      { latitude?: unknown; longitude?: unknown; formattedAddress?: unknown } | undefined;
    return {
      latitude: typeof stored?.latitude === 'number' ? stored.latitude : 0,
      longitude: typeof stored?.longitude === 'number' ? stored.longitude : 0,
      formattedAddress: typeof stored?.formattedAddress === 'string' ? stored.formattedAddress : '',
    };
  };

  return {
    ...toRow(tripId, data),
    origin: place(data.origin),
    destination: place(data.destination),
    estimatedDistance: typeof data.estimatedDistance === 'number' ? data.estimatedDistance : null,
    estimatedDuration: typeof data.estimatedDuration === 'number' ? data.estimatedDuration : null,
    vehicleType: typeof data.vehicleType === 'string' ? data.vehicleType : null,
    vehicleMake: typeof data.vehicleMake === 'string' ? data.vehicleMake : null,
    vehicleModel: typeof data.vehicleModel === 'string' ? data.vehicleModel : null,
    vehiclePlateNumber:
      typeof data.vehiclePlateNumber === 'string' ? data.vehiclePlateNumber : null,
    authorizedAmountMinorUnits:
      typeof data.authorizedAmountMinorUnits === 'number' ? data.authorizedAmountMinorUnits : null,
    refundedAmountMinorUnits:
      typeof data.refundedAmountMinorUnits === 'number' ? data.refundedAmountMinorUnits : null,
    platformFeeMinorUnits:
      typeof data.platformFeeMinorUnits === 'number' ? data.platformFeeMinorUnits : null,
  };
}
