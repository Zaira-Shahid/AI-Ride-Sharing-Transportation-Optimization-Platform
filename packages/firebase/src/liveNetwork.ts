import type { DriverJourneyStatus } from '@ridemesh/types';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import type { FirebaseClient } from './client';

// Module 11.5 (admin dashboard: live map, first pass - vehicles only). Unlike tripRequests (module
// 11.4), driverJourneys already has a direct staff read rule (docs/security.md: "the driver
// themselves... and verified staff can read them"), so this is a genuine live Firestore subscription,
// not a polled callable - the staff-side isStaff() check is unconditional on the document, so an
// unfiltered/status-filtered list query is allowed the same way it already is for drivers/vehicles/
// users (see adminReview.ts's own note).
//
// Scoped with the user (deferred to a later module, not built here): pickup/drop-off/unmatched-request
// markers (exact trip-request places, the same audited-access category as 11.4), the high-demand-area
// heatmap, and average occupancy/vehicles saved/emissions saved/network efficiency (section 33's own
// "should estimate... label as estimates" - needs an agreed methodology first, not invented here).

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
}

function readPosition(value: unknown): MapPosition | null {
  const record = value as { latitude?: unknown; longitude?: unknown } | null | undefined;
  return typeof record?.latitude === 'number' && typeof record?.longitude === 'number'
    ? { latitude: record.latitude, longitude: record.longitude }
    : null;
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
          };
        }),
      );
    },
    onError,
  );
}
