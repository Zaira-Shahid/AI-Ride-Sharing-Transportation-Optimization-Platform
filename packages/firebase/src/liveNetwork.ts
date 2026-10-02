import type { DriverJourneyStatus, LiveTripPosition } from '@ridemesh/types';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

// Module 11.5 (admin dashboard: live map, first pass - vehicles only). Unlike tripRequests (module
// 11.4), driverJourneys already has a direct staff read rule (docs/security.md: "the driver
// themselves... and verified staff can read them"), so this is a genuine live Firestore subscription,
// not a polled callable - the staff-side isStaff() check is unconditional on the document, so an
// unfiltered/status-filtered list query is allowed the same way it already is for drivers/vehicles/
// users (see adminReview.ts's own note).
//
// Module 11.5, second pass: pickup/drop-off/unmatched-request markers and the high-demand heatmap
// (listActiveTripPositions, below) - deferred from the first pass above because they need a trip's
// own place, the same audited-access category 11.4 drew a hard line around. User-confirmed
// resolution: every position the callable returns is already rounded server-side
// (functions/src/liveNetwork.ts), so this file never has the exact place to begin with.
//
// "Network efficiency" (also deferred from the first pass): user-confirmed definition is the share
// of right-now MATCHING/ACTIVE journeys (ones that have actually picked up at least one passenger,
// unlike AVAILABLE) carrying more than one - a genuinely live number, not Phase 12 Analytics' own
// cumulative/historical average occupancy. ActiveVehicle's own new passengerCount field (below) is
// what the admin UI computes that share from; nothing here computes the percentage itself, to keep
// this file's own job to exactly "what does Firestore say right now", the same boundary the rest of
// this file already draws.

const ACTIVE_JOURNEY_STATUSES: readonly DriverJourneyStatus[] = ['AVAILABLE', 'MATCHING', 'ACTIVE'];

export interface MapPosition {
  latitude: number;
  longitude: number;
}

/**
 * One currently-active journey: a driver online with a matched or matching journey. `currentRoute`
 * is never populated anywhere in this codebase (always null, a placeholder field) and staff cannot
 * call calculateRoute (docs/security.md: "Only a verified driver or passenger can ask; staff
 * cannot"), so `origin`/`destination` are the only route data available - a straight line between
 * them, not the driver's actual road route.
 */
export interface ActiveVehicle {
  journeyId: string;
  status: DriverJourneyStatus;
  currentPosition: MapPosition | null;
  origin: MapPosition | null;
  destination: MapPosition | null;
  /** How many requests this journey has actually matched (module 11.5's own "network efficiency" - a MATCHING/ACTIVE journey with more than one is currently sharing). Always 0 for an AVAILABLE journey (nobody matched yet). */
  passengerCount: number;
}

function readPosition(value: unknown): MapPosition | null {
  const record = value as { latitude?: unknown; longitude?: unknown } | null | undefined;
  return typeof record?.latitude === 'number' && typeof record?.longitude === 'number'
    ? { latitude: record.latitude, longitude: record.longitude }
    : null;
}

function readPassengerCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function isActiveStatus(value: unknown): value is DriverJourneyStatus {
  return (ACTIVE_JOURNEY_STATUSES as readonly unknown[]).includes(value);
}

/** Follows every currently-active journey live - the map's own data source, and the "active vehicles" count. */
export function subscribeToActiveVehicles(
  client: Pick<FirebaseClient, 'firestore'>,
  onChange: (vehicles: ActiveVehicle[]) => void,
  onError: (error: unknown) => void,
): () => void {
  return onSnapshot(
    query(
      collection(client.firestore, 'driverJourneys'),
      where('status', 'in', [...ACTIVE_JOURNEY_STATUSES]),
    ),
    (snapshot) => {
      onChange(
        snapshot.docs.map((doc) => {
          const data = doc.data();
          return {
            journeyId: doc.id,
            status: isActiveStatus(data.status) ? data.status : 'AVAILABLE',
            currentPosition: readPosition(data.currentLocation),
            origin: readPosition(data.origin),
            destination: readPosition(data.destination),
            passengerCount: readPassengerCount(data.matchedTripRequestIds),
          };
        }),
      );
    },
    onError,
  );
}

/** Every currently-open trip's own rounded pickup/drop-off (module 11.5, second pass) - polled, like listActiveTrips, since tripRequests has no staff Firestore rule to subscribe to directly. */
export async function listActiveTripPositions(
  client: Pick<FirebaseClient, 'functions'>,
): Promise<LiveTripPosition[]> {
  try {
    const result = await httpsCallable<undefined, LiveTripPosition[]>(
      client.functions,
      'listActiveTripPositions',
    )();
    return result.data;
  } catch (error) {
    if (getErrorCode(error) === 'functions/permission-denied') {
      throw new AuthFlowError('permission', 'You are not allowed to view the live network.');
    }
    throw error;
  }
}
