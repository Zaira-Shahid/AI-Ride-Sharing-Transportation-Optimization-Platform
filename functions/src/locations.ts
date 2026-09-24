import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { requireVerifiedDriver, type DriverCaller } from './callers.js';

// Functions deploy from this directory alone, so these mirror gps.ts in @ridemesh/types.
// tests/roles-parity.test.ts fails if they diverge.
export const LOCATION_THROTTLE = {
  minIntervalMs: 30_000,
  minDistanceMeters: 50,
  heartbeatIntervalMs: 5 * 60_000,
  maxAccuracyMeters: 100,
  serverMinIntervalMs: 15_000,
} as const;

export const updateDriverLocationInputSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(1_000_000).nullish(),
  })
  .refine((point) => !(point.latitude === 0 && point.longitude === 0));

export type UpdateDriverLocationResult = { status: 'updated' | 'ignored' | 'throttled' };

export function isUsableAccuracy(accuracy: number | null | undefined): boolean {
  if (accuracy === null || accuracy === undefined) return true;
  return (
    Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= LOCATION_THROTTLE.maxAccuracyMeters
  );
}

/**
 * Records where the calling driver is, on their journey, while they are online. The app decides
 * how often to send (adaptive: see shouldSendLocation in @ridemesh/types); the server does not
 * trust that and checks again:
 * - only a verified driver with an ACTIVE account who is ONLINE can write a position (a driver who
 *   is offline has no business sharing one), and only on their own journey;
 * - a reading less accurate than maxAccuracyMeters is ignored, not stored;
 * - a write less than serverMinIntervalMs after the last one is throttled, not stored, whatever the
 *   app does (a buggy or hostile client cannot write every second).
 * Ignored and throttled readings are normal outcomes and come back as such, not as errors. The
 * position is location data of a private person: it is never written to the audit log or logged.
 *
 * Module 7.6 (live map): the same reading is copied onto every one of the journey's own
 * matchedTripRequestIds, so a matched passenger can see it without needing read access to
 * driverJourneys itself (the same one-way snapshot pattern as driverName/vehicle, Module 7.3) - no
 * new Firestore rule. Written to every id in that list regardless of the request's own current status
 * (COMPLETED/CANCELLED ones too): harmless (nobody reads a closed request's location) and avoids an
 * extra read per id just to filter them out.
 */
export async function updateDriverLocation(
  deps: { firestore: Firestore; now?: () => number },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<UpdateDriverLocationResult> {
  requireVerifiedDriver(caller);

  const parsed = updateDriverLocationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The location is not valid.');
  }
  const { latitude, longitude, accuracy } = parsed.data;
  if (!isUsableAccuracy(accuracy)) return { status: 'ignored' };

  const { firestore } = deps;
  const now = (deps.now ?? Date.now)();
  const userRef = firestore.collection('users').doc(caller.uid);
  const driverRef = firestore.collection('drivers').doc(caller.uid);

  return firestore.runTransaction(async (tx): Promise<UpdateDriverLocationResult> => {
    const [user, driver] = await Promise.all([tx.get(userRef), tx.get(driverRef)]);
    if (!user.exists || user.get('status') !== 'ACTIVE' || !driver.exists) {
      throw new HttpsError('failed-precondition', 'This account cannot share a location.');
    }
    if (driver.get('availabilityStatus') !== 'ONLINE') {
      throw new HttpsError('failed-precondition', 'Go online before you share your location.');
    }

    const currentId: unknown = driver.get('currentJourneyId');
    const journeyRef =
      typeof currentId === 'string' && currentId
        ? firestore.collection('driverJourneys').doc(currentId)
        : null;
    const journey = journeyRef ? await tx.get(journeyRef) : undefined;
    if (!journeyRef || !journey?.exists || journey.get('driverId') !== caller.uid) {
      throw new HttpsError('failed-precondition', 'You have no journey to share a location for.');
    }

    const last: unknown = journey.get('currentLocation');
    const lastAt =
      typeof last === 'object' && last !== null && 'updatedAt' in last
        ? (last as { updatedAt: unknown }).updatedAt
        : null;
    if (
      lastAt instanceof Timestamp &&
      now - lastAt.toMillis() < LOCATION_THROTTLE.serverMinIntervalMs
    ) {
      return { status: 'throttled' };
    }

    const location = {
      latitude,
      longitude,
      accuracy: accuracy ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.update(journeyRef, { currentLocation: location, updatedAt: FieldValue.serverTimestamp() });

    const matchedTripRequestIds = journey.get('matchedTripRequestIds');
    if (Array.isArray(matchedTripRequestIds)) {
      for (const tripId of matchedTripRequestIds) {
        if (typeof tripId !== 'string' || !tripId) continue;
        tx.update(firestore.collection('tripRequests').doc(tripId), {
          driverLocation: location,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }
    return { status: 'updated' };
  });
}
