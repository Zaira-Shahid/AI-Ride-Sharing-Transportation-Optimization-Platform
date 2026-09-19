import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { requireVerifiedDriver, type DriverCaller } from './callers.js';

// Functions deploy from this directory alone, so these mirror @ridemesh/types.
// tests/roles-parity.test.ts fails if they diverge.
export const destinationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  formattedAddress: z.string().trim().min(1).max(300),
  placeId: z.string().trim().min(1).max(300).nullish(),
});
export const declareDestinationInputSchema = z.object({ destination: destinationSchema });

export const NEW_JOURNEY_DEFAULTS = {
  origin: null,
  departureTime: null,
  availableSeats: null,
  maxDetourMinutes: null,
  maxDetourDistance: null,
  status: 'DRAFT',
  currentLocation: null,
  currentRoute: null,
} as const;

export type DeclareDestinationResult = { status: 'created' | 'updated' | 'unchanged' };

interface StoredDestination {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  placeId: string | null;
}

function sameDestination(stored: unknown, next: StoredDestination): boolean {
  if (typeof stored !== 'object' || stored === null) return false;
  const current = stored as Record<string, unknown>;
  return (
    current.latitude === next.latitude &&
    current.longitude === next.longitude &&
    current.formattedAddress === next.formattedAddress &&
    (current.placeId ?? null) === next.placeId
  );
}

/**
 * Sets where the calling driver is heading. A driver has at most one open journey, found through
 * drivers/{uid}.currentJourneyId: the first declaration creates it as a DRAFT and later ones
 * replace its destination while it is still a DRAFT. Seats on offer and detour limits are added to
 * the same journey by later modules.
 *
 * The coordinates and address come from the app's place search and are checked only for shape and
 * range; they are the driver's own claim. The address is not written to the audit log, because a
 * destination is location data and only the journey's creation needs recording.
 */
export async function declareDestination(
  deps: { firestore: Firestore },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<DeclareDestinationResult> {
  requireVerifiedDriver(caller);

  const parsed = declareDestinationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The destination is not valid.');
  }
  const { destination: input } = parsed.data;
  const destination: StoredDestination = {
    latitude: input.latitude,
    longitude: input.longitude,
    formattedAddress: input.formattedAddress,
    placeId: input.placeId ?? null,
  };

  const { firestore } = deps;
  const userRef = firestore.collection('users').doc(caller.uid);
  const driverRef = firestore.collection('drivers').doc(caller.uid);
  const vehicleRef = firestore.collection('vehicles').doc(caller.uid);
  const journeys = firestore.collection('driverJourneys');

  return firestore.runTransaction(async (tx): Promise<DeclareDestinationResult> => {
    const [user, driver, vehicle] = await Promise.all([
      tx.get(userRef),
      tx.get(driverRef),
      tx.get(vehicleRef),
    ]);
    if (!user.exists || user.get('status') !== 'ACTIVE' || !driver.exists || !vehicle.exists) {
      throw new HttpsError(
        'failed-precondition',
        'This account cannot set a destination right now.',
      );
    }

    const currentId: unknown = driver.get('currentJourneyId');
    const currentRef = typeof currentId === 'string' && currentId ? journeys.doc(currentId) : null;
    const current = currentRef ? await tx.get(currentRef) : undefined;

    if (currentRef && current?.exists) {
      if (current.get('driverId') !== caller.uid || current.get('status') !== 'DRAFT') {
        throw new HttpsError(
          'failed-precondition',
          'The destination cannot be changed for this journey.',
        );
      }
      if (sameDestination(current.get('destination'), destination)) return { status: 'unchanged' };
      tx.update(currentRef, { destination, updatedAt: FieldValue.serverTimestamp() });
      return { status: 'updated' };
    }

    // No open journey yet (or the pointer is stale): start one.
    const journeyRef = journeys.doc();
    tx.create(journeyRef, {
      driverId: caller.uid,
      vehicleId: caller.uid,
      destination,
      ...NEW_JOURNEY_DEFAULTS,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(driverRef, {
      currentJourneyId: journeyRef.id,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: 'JOURNEY_CREATED',
      entity: `driverJourneys/${journeyRef.id}`,
      previousState: null,
      newState: { status: NEW_JOURNEY_DEFAULTS.status },
      reason: 'Driver declared a destination',
    });
    return { status: 'created' };
  });
}
