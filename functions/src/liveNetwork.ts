import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { roundForGeocoding } from './geocoding.js';
import { isStaffRole } from './roles.js';
import { OPEN_TRIP_STATUSES } from './tripRequests.js';
import type { StaffCaller } from './verification.js';

// Module 11.5, second pass (admin dashboard: live map markers). The first pass
// (packages/firebase/src/liveNetwork.ts's own header comment) deferred pickup/drop-off/unmatched-
// request markers specifically because they need a trip's own place, the same audited-access
// category module 11.4 drew a hard line around: docs/security.md and tripMonitoring.ts are explicit
// that no trip LIST view ever carries an exact place, only the single-trip audited detail call does.
// A live map showing every open trip's place at once is exactly that kind of unaudited, aggregate
// exposure - user-confirmed resolution: every position here is rounded the same ~11m way
// reverseGeocode already rounds a position before it is ever looked up or cached
// (geocoding.ts's own roundForGeocoding) - approximate enough for an operational overview (where
// demand clusters, roughly), never precise enough to be the exact place the audited detail call
// alone still provides. Not audited, same stance as listActiveTripsForStaff: a rounded position is
// not the exact place the audit boundary exists to protect.
//
// "Unmatched" (REQUESTED/SEARCHING - no driver yet) is carried as its own boolean rather than a
// separate endpoint/query, so the admin map can style those markers differently (section 48's own
// "Unmatched request" marker type) from a matched trip's pickup/drop-off, in one request.

const ACTIVE_TRIP_POSITIONS_LIMIT = 500;
const UNMATCHED_STATUSES = new Set(['REQUESTED', 'SEARCHING']);

export interface RoundedPoint {
  latitude: number;
  longitude: number;
}

export interface LiveTripPosition {
  tripId: string;
  unmatched: boolean;
  sharedRide: boolean;
  pickup: RoundedPoint | null;
  dropoff: RoundedPoint | null;
}

function requireStaff(caller: StaffCaller): void {
  if (!isStaffRole(caller.role) || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'You are not allowed to view the live network.');
  }
}

function roundedPointOf(value: unknown): RoundedPoint | null {
  const record = value as { latitude?: unknown; longitude?: unknown } | null | undefined;
  if (typeof record?.latitude !== 'number' || typeof record?.longitude !== 'number') {
    return null;
  }
  return roundForGeocoding({ latitude: record.latitude, longitude: record.longitude });
}

/**
 * Every currently-open trip's own rounded pickup/drop-off, for the live map's own markers and
 * high-demand heatmap (both built from this same rounded data - a heatmap needs no exact point for
 * any single trip either). Not audited; no exact place is ever read into the response.
 */
export async function listActiveTripPositionsForStaff(
  deps: { firestore: Firestore },
  caller: StaffCaller,
): Promise<LiveTripPosition[]> {
  requireStaff(caller);
  const snapshot = await deps.firestore
    .collection('tripRequests')
    .where('status', 'in', [...OPEN_TRIP_STATUSES])
    .limit(ACTIVE_TRIP_POSITIONS_LIMIT)
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      tripId: doc.id,
      unmatched: UNMATCHED_STATUSES.has(data.status),
      sharedRide: data.sharedRide === true,
      pickup: roundedPointOf(data.origin),
      dropoff: roundedPointOf(data.destination),
    };
  });
}
