import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { requireVerifiedDriver, type DriverCaller } from './callers.js';
import { SEAT_CAPACITY_MAX, SEAT_CAPACITY_MIN } from './vehicles.js';

// Functions deploy from this directory alone, so these mirror @ridemesh/types.
// tests/roles-parity.test.ts fails if they diverge.
export const destinationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  formattedAddress: z.string().trim().min(1).max(300),
  placeId: z.string().trim().min(1).max(300).nullish(),
});
export const declareDestinationInputSchema = z.object({ destination: destinationSchema });
export const setJourneySeatsInputSchema = z.object({
  availableSeats: z.number().int().min(SEAT_CAPACITY_MIN).max(SEAT_CAPACITY_MAX),
});

// Extra minutes and kilometres a driver accepts. Availability.ts repeats these two ranges as plain
// numbers (it cannot import this file); tests/roles-parity.test.ts checks all of them.
export const DETOUR_MINUTES_MIN = 1;
export const DETOUR_MINUTES_MAX = 60;
export const DETOUR_DISTANCE_KM_MIN = 1;
export const DETOUR_DISTANCE_KM_MAX = 30;
export const setJourneyDetourInputSchema = z.object({
  maxDetourMinutes: z.number().int().min(DETOUR_MINUTES_MIN).max(DETOUR_MINUTES_MAX),
  maxDetourDistance: z.number().int().min(DETOUR_DISTANCE_KM_MIN).max(DETOUR_DISTANCE_KM_MAX),
});

// Where the journey starts (Module 4.1): one reading from the driver's device, saved on purpose.
// Mirrors gps.ts in @ridemesh/types; tests/roles-parity.test.ts fails if they diverge.
export const ORIGIN_ADDRESS = 'Current location';
export const setJourneyOriginInputSchema = z.object({
  origin: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .refine((point) => !(point.latitude === 0 && point.longitude === 0)),
  address: z.string().trim().min(1).max(300).nullish(),
});

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
export type SetJourneySeatsResult = { status: 'updated' | 'unchanged' };
export type SetJourneyDetourResult = { status: 'updated' | 'unchanged' };
export type SetJourneyOriginResult = { status: 'updated' | 'unchanged' };

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
 * replace its destination while it is still a DRAFT. Seats on offer (setJourneySeats) and detour
 * limits (setJourneyDetour) are added to the same journey.
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

/**
 * Sets how many passenger seats the calling driver offers on their open journey: at least one and
 * never more than the vehicle's seatCapacity, which is why this is a function and not a rule.
 * Like the destination, it can only be changed while the journey is a DRAFT. It needs a journey
 * (so a destination) and a vehicle with its capacity set. Routine changes are not audited.
 */
export async function setJourneySeats(
  deps: { firestore: Firestore },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<SetJourneySeatsResult> {
  requireVerifiedDriver(caller);

  const parsed = setJourneySeatsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The number of seats is not valid.');
  }
  const { availableSeats } = parsed.data;

  const { firestore } = deps;
  const userRef = firestore.collection('users').doc(caller.uid);
  const driverRef = firestore.collection('drivers').doc(caller.uid);
  const vehicleRef = firestore.collection('vehicles').doc(caller.uid);

  return firestore.runTransaction(async (tx): Promise<SetJourneySeatsResult> => {
    const [user, driver, vehicle] = await Promise.all([
      tx.get(userRef),
      tx.get(driverRef),
      tx.get(vehicleRef),
    ]);
    if (!user.exists || user.get('status') !== 'ACTIVE' || !driver.exists || !vehicle.exists) {
      throw new HttpsError('failed-precondition', 'This account cannot set seats right now.');
    }

    const currentId: unknown = driver.get('currentJourneyId');
    const journeyRef =
      typeof currentId === 'string' && currentId
        ? firestore.collection('driverJourneys').doc(currentId)
        : null;
    const journey = journeyRef ? await tx.get(journeyRef) : undefined;
    if (!journeyRef || !journey?.exists || journey.get('driverId') !== caller.uid) {
      throw new HttpsError('failed-precondition', 'Set your destination before you offer seats.');
    }
    if (journey.get('status') !== 'DRAFT') {
      throw new HttpsError('failed-precondition', 'The seats cannot be changed for this journey.');
    }

    const capacity: unknown = vehicle.get('seatCapacity');
    if (typeof capacity !== 'number') {
      throw new HttpsError('failed-precondition', 'Set the passenger seats of your vehicle first.');
    }
    if (availableSeats > capacity) {
      throw new HttpsError(
        'invalid-argument',
        'You cannot offer more seats than your vehicle has.',
      );
    }

    if (journey.get('availableSeats') === availableSeats) return { status: 'unchanged' };
    tx.update(journeyRef, { availableSeats, updatedAt: FieldValue.serverTimestamp() });
    return { status: 'updated' };
  });
}

/**
 * Sets how far the calling driver will go out of their way on their open journey: extra minutes
 * (1 to 60) and extra kilometres (1 to 30), both whole numbers and always set together. Like the
 * destination and the seats, they can only be changed while the journey is a DRAFT, and they need
 * a journey (so a destination first). Routine changes are not audited.
 */
export async function setJourneyDetour(
  deps: { firestore: Firestore },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<SetJourneyDetourResult> {
  requireVerifiedDriver(caller);

  const parsed = setJourneyDetourInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The detour limits are not valid.');
  }
  const { maxDetourMinutes, maxDetourDistance } = parsed.data;

  const { firestore } = deps;
  const userRef = firestore.collection('users').doc(caller.uid);
  const driverRef = firestore.collection('drivers').doc(caller.uid);

  return firestore.runTransaction(async (tx): Promise<SetJourneyDetourResult> => {
    const [user, driver] = await Promise.all([tx.get(userRef), tx.get(driverRef)]);
    if (!user.exists || user.get('status') !== 'ACTIVE' || !driver.exists) {
      throw new HttpsError('failed-precondition', 'This account cannot set a detour right now.');
    }

    const currentId: unknown = driver.get('currentJourneyId');
    const journeyRef =
      typeof currentId === 'string' && currentId
        ? firestore.collection('driverJourneys').doc(currentId)
        : null;
    const journey = journeyRef ? await tx.get(journeyRef) : undefined;
    if (!journeyRef || !journey?.exists || journey.get('driverId') !== caller.uid) {
      throw new HttpsError('failed-precondition', 'Set your destination before you set a detour.');
    }
    if (journey.get('status') !== 'DRAFT') {
      throw new HttpsError('failed-precondition', 'The detour cannot be changed for this journey.');
    }

    if (
      journey.get('maxDetourMinutes') === maxDetourMinutes &&
      journey.get('maxDetourDistance') === maxDetourDistance
    ) {
      return { status: 'unchanged' };
    }
    tx.update(journeyRef, {
      maxDetourMinutes,
      maxDetourDistance,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status: 'updated' };
  });
}

/**
 * Saves where the calling driver's journey starts: the position of their device, read once by the
 * app when the driver asks for it. Its address is the one the app found for the position (reverse
 * geocoding, Module 4.2: the app's claim, like a destination's) or, when there is none, "Current
 * location"; it has its coordinates and no place ID, the same shape as a destination. Like the other parts of a journey it can only be changed while
 * the journey is a DRAFT and needs a journey (so a destination first). It is the driver's own claim,
 * checked only for shape and range. The position is not written to the audit log.
 */
export async function setJourneyOrigin(
  deps: { firestore: Firestore },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<SetJourneyOriginResult> {
  requireVerifiedDriver(caller);

  const parsed = setJourneyOriginInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The start of the journey is not valid.');
  }
  const { latitude, longitude } = parsed.data.origin;
  const origin: StoredDestination = {
    latitude,
    longitude,
    formattedAddress: parsed.data.address ?? ORIGIN_ADDRESS,
    placeId: null,
  };

  const { firestore } = deps;
  const userRef = firestore.collection('users').doc(caller.uid);
  const driverRef = firestore.collection('drivers').doc(caller.uid);

  return firestore.runTransaction(async (tx): Promise<SetJourneyOriginResult> => {
    const [user, driver] = await Promise.all([tx.get(userRef), tx.get(driverRef)]);
    if (!user.exists || user.get('status') !== 'ACTIVE' || !driver.exists) {
      throw new HttpsError('failed-precondition', 'This account cannot set a start right now.');
    }

    const currentId: unknown = driver.get('currentJourneyId');
    const journeyRef =
      typeof currentId === 'string' && currentId
        ? firestore.collection('driverJourneys').doc(currentId)
        : null;
    const journey = journeyRef ? await tx.get(journeyRef) : undefined;
    if (!journeyRef || !journey?.exists || journey.get('driverId') !== caller.uid) {
      throw new HttpsError('failed-precondition', 'Set your destination before you set a start.');
    }
    if (journey.get('status') !== 'DRAFT') {
      throw new HttpsError('failed-precondition', 'The start cannot be changed for this journey.');
    }

    if (sameDestination(journey.get('origin'), origin)) return { status: 'unchanged' };
    tx.update(journeyRef, { origin, updatedAt: FieldValue.serverTimestamp() });
    return { status: 'updated' };
  });
}
