import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { requireVerifiedPassenger, type PassengerCaller } from './callers.js';
import { destinationSchema } from './journeys.js';

// Functions deploy from this directory alone, so these mirror @ridemesh/types (trip-request.ts,
// trip.ts, trip-times.ts, flexibility.ts). tests/roles-parity.test.ts fails if they diverge.

export const OPEN_TRIP_STATUSES = [
  'REQUESTED',
  'SEARCHING',
  'MATCHED',
  'PICKUP_ASSIGNED',
  'DRIVER_ARRIVING',
  'PICKED_UP',
  'IN_TRANSIT',
  'DROPOFF_APPROACHING',
] as const;

export const TRIP_REQUEST_REFUSALS = [
  'INVALID',
  'UNUSABLE_PLACE',
  'SAME_PLACE',
  'TIME_INVALID',
  'TIME_TOO_SOON',
  'TIME_TOO_FAR',
  'ARRIVAL_NOT_AFTER_DEPARTURE',
  'PREFERENCES',
  'ALREADY_OPEN',
  'ACCOUNT',
  'NOT_FOUND',
  'NOT_CANCELLABLE',
] as const;
export type TripRequestRefusal = (typeof TRIP_REQUEST_REFUSALS)[number];

export const NEW_TRIP_REQUEST_DEFAULTS = {
  status: 'REQUESTED',
  estimatedFare: null,
  estimatedDistance: null,
  estimatedDuration: null,
  assignedPlanId: null,
  // How many candidates matching found (Module 5.2/5.3): filled in only for a leave-now request,
  // once it starts SEARCHING; null until then, and always for a future-dated one.
  candidateCount: null,
} as const;

export const SAME_PLACE_DISTANCE_METERS = 50;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const MIN_LEAD_MINUTES = 5;
export const MAX_AHEAD_DAYS = 7;
export const MIN_ARRIVAL_GAP_MINUTES = 1;

const FLEXIBILITY_LEVELS = ['STRICT', 'BALANCED', 'FLEXIBLE'] as const;
export const FLEXIBILITY_LEVEL_LIMITS = {
  STRICT: { maxWalkingDistance: 200, maxExtraTime: 5, maxDetourDistance: 1 },
  BALANCED: { maxWalkingDistance: 500, maxExtraTime: 10, maxDetourDistance: 3 },
  FLEXIBLE: { maxWalkingDistance: 1000, maxExtraTime: 20, maxDetourDistance: 5 },
} as const;

export const flexibilityPreferencesSchema = z.object({
  flexibilityLevel: z.enum(FLEXIBILITY_LEVELS),
  maxWalkingDistance: z.number().int().positive(),
  maxExtraTime: z.number().int().positive(),
  maxDetourDistance: z.number().int().positive(),
  allowSharedRide: z.boolean(),
  allowRouteChange: z.boolean(),
});

export const createTripRequestInputSchema = z.object({
  origin: destinationSchema,
  destination: destinationSchema,
  departure: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('NOW') }),
    z.object({ kind: z.literal('AT'), at: z.number() }),
  ]),
  arriveBy: z.number().nullable(),
  preferences: flexibilityPreferencesSchema,
});
export const cancelTripRequestInputSchema = z.object({ tripId: z.string().min(1).max(200) });

export type CreateTripRequestResult = { tripId: string };
export type CancelTripRequestResult = { status: 'cancelled' | 'unchanged' };

interface Place {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  placeId?: string | null | undefined;
}
interface StoredPlace {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  placeId: string | null;
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

export function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLatitude = toRadians(b.latitude - a.latitude);
  const dLongitude = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLatitude / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) *
      Math.cos(toRadians(b.latitude)) *
      Math.sin(dLongitude / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isSamePlace(a: StoredPlace, b: StoredPlace): boolean {
  if (a.placeId && b.placeId && a.placeId === b.placeId) return true;
  return distanceMeters(a, b) < SAME_PLACE_DISTANCE_METERS;
}

/** Whether a place is usable for a trip: the shape is already checked by the schema; 0, 0 is no position. */
export function isUsablePlace(place: Place): boolean {
  return !(place.latitude === 0 && place.longitude === 0);
}

export type TimeProblem = 'INVALID' | 'TOO_SOON' | 'TOO_FAR';

export function findTimeProblem(at: number, now: number): TimeProblem | null {
  if (typeof at !== 'number' || !Number.isFinite(at)) return 'INVALID';
  if (at < now + MIN_LEAD_MINUTES * MINUTE_MS) return 'TOO_SOON';
  if (at > now + MAX_AHEAD_DAYS * DAY_MS) return 'TOO_FAR';
  return null;
}

export interface TripTimes {
  departure: { kind: 'NOW' } | { kind: 'AT'; at: number };
  arriveBy: number | null;
}

export interface TripTimesProblem {
  field: 'departure' | 'arriveBy';
  problem: TimeProblem | 'NOT_AFTER_DEPARTURE';
}

export function checkTripTimes(times: TripTimes, now: number): TripTimesProblem | null {
  if (times.departure.kind === 'AT') {
    const problem = findTimeProblem(times.departure.at, now);
    if (problem) return { field: 'departure', problem };
  }
  if (times.arriveBy !== null) {
    const problem = findTimeProblem(times.arriveBy, now);
    if (problem) return { field: 'arriveBy', problem };
    const departsAt = times.departure.kind === 'AT' ? times.departure.at : now;
    if (times.arriveBy < departsAt + MIN_ARRIVAL_GAP_MINUTES * MINUTE_MS) {
      return { field: 'arriveBy', problem: 'NOT_AFTER_DEPARTURE' };
    }
  }
  return null;
}

export function isValidFlexibilityPreferences(value: unknown): boolean {
  const parsed = flexibilityPreferencesSchema.safeParse(value);
  if (!parsed.success) return false;
  const limits = FLEXIBILITY_LEVEL_LIMITS[parsed.data.flexibilityLevel];
  return (
    parsed.data.maxWalkingDistance === limits.maxWalkingDistance &&
    parsed.data.maxExtraTime === limits.maxExtraTime &&
    parsed.data.maxDetourDistance === limits.maxDetourDistance
  );
}

function refuse(code: FunctionsErrorCode, reason: TripRequestRefusal, message: string): HttpsError {
  return new HttpsError(code, message, { reason });
}

const TIME_REFUSALS: Record<
  TripTimesProblem['problem'],
  { reason: TripRequestRefusal; message: string }
> = {
  INVALID: { reason: 'TIME_INVALID', message: 'That time is not valid.' },
  TOO_SOON: { reason: 'TIME_TOO_SOON', message: 'That time is too soon. Choose a later time.' },
  TOO_FAR: {
    reason: 'TIME_TOO_FAR',
    message: 'That time is too far ahead. Choose an earlier time.',
  },
  NOT_AFTER_DEPARTURE: {
    reason: 'ARRIVAL_NOT_AFTER_DEPARTURE',
    message: 'The arrival time must be after the departure time.',
  },
};

function storedPlace(place: Place): StoredPlace {
  return {
    latitude: place.latitude,
    longitude: place.longitude,
    formattedAddress: place.formattedAddress,
    placeId: place.placeId ?? null,
  };
}

function isOpen(status: unknown): boolean {
  return (OPEN_TRIP_STATUSES as readonly unknown[]).includes(status);
}

/**
 * Creates the calling passenger's trip request (REQUESTED). Everything the app sent is checked
 * again with the server's clock: the places, that they are not the same place, the times, and that
 * the preferences are exactly a level's. A passenger has at most one open request, found through
 * users/{uid}.currentTripRequestId, and it starts with no fare, distance or duration (Phase 4).
 *
 * The request holds exact coordinates of a private person, so the audit entry carries the status
 * only, and the function logs nothing about the places.
 */
export async function createTripRequest(
  deps: { firestore: Firestore; now?: () => number },
  caller: PassengerCaller,
  rawInput: unknown,
): Promise<CreateTripRequestResult> {
  requireVerifiedPassenger(caller);

  const parsed = createTripRequestInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw refuse('invalid-argument', 'INVALID', 'The trip request is not valid.');
  }
  const input = parsed.data;

  const origin = storedPlace(input.origin);
  const destination = storedPlace(input.destination);
  if (!isUsablePlace(origin) || !isUsablePlace(destination)) {
    throw refuse('invalid-argument', 'UNUSABLE_PLACE', 'One of the places cannot be used.');
  }
  if (isSamePlace(origin, destination)) {
    throw refuse(
      'invalid-argument',
      'SAME_PLACE',
      'The pickup and the destination are the same place.',
    );
  }

  const now = (deps.now ?? Date.now)();
  const timeProblem = checkTripTimes(
    {
      departure:
        input.departure.kind === 'AT' ? { kind: 'AT', at: input.departure.at } : { kind: 'NOW' },
      arriveBy: input.arriveBy,
    },
    now,
  );
  if (timeProblem) {
    const { reason, message } = TIME_REFUSALS[timeProblem.problem];
    throw refuse('invalid-argument', reason, message);
  }

  if (!isValidFlexibilityPreferences(input.preferences)) {
    throw refuse('invalid-argument', 'PREFERENCES', 'Those flexibility preferences are not valid.');
  }

  const { firestore } = deps;
  const userRef = firestore.collection('users').doc(caller.uid);
  const trips = firestore.collection('tripRequests');

  return firestore.runTransaction(async (tx): Promise<CreateTripRequestResult> => {
    const user = await tx.get(userRef);
    if (!user.exists || user.get('status') !== 'ACTIVE') {
      throw refuse(
        'failed-precondition',
        'ACCOUNT',
        'This account cannot request a ride right now.',
      );
    }

    const currentId: unknown = user.get('currentTripRequestId');
    if (typeof currentId === 'string' && currentId) {
      const current = await tx.get(trips.doc(currentId));
      if (
        current.exists &&
        current.get('passengerId') === caller.uid &&
        isOpen(current.get('status'))
      ) {
        throw refuse('failed-precondition', 'ALREADY_OPEN', 'You already have a ride requested.');
      }
      // A stale pointer (the request is gone or has ended): a new one replaces it.
    }

    const tripRef = trips.doc();
    tx.create(tripRef, {
      passengerId: caller.uid,
      origin,
      destination,
      requestedAt: FieldValue.serverTimestamp(),
      requestedDepartureTime:
        input.departure.kind === 'AT'
          ? Timestamp.fromMillis(input.departure.at)
          : FieldValue.serverTimestamp(),
      arrivalDeadline: input.arriveBy === null ? null : Timestamp.fromMillis(input.arriveBy),
      passengerPreferences: input.preferences,
      ...NEW_TRIP_REQUEST_DEFAULTS,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(userRef, {
      currentTripRequestId: tripRef.id,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: 'TRIP_REQUEST_CREATED',
      entity: `tripRequests/${tripRef.id}`,
      previousState: null,
      newState: { status: NEW_TRIP_REQUEST_DEFAULTS.status },
      reason: 'Passenger requested a ride',
    });
    return { tripId: tripRef.id };
  });
}

/**
 * Cancels the calling passenger's request. Only a REQUESTED or SEARCHING one can be cancelled
 * (canPassengerCancel, and the move must be an allowed transition); one that is already CANCELLED is
 * left as it is (unchanged), so a repeated tap or retry is harmless. It also clears the passenger's
 * pointer to it. Somebody else's request is reported as not found.
 */
export async function cancelTripRequest(
  deps: { firestore: Firestore },
  caller: PassengerCaller,
  rawInput: unknown,
): Promise<CancelTripRequestResult> {
  requireVerifiedPassenger(caller);

  const parsed = cancelTripRequestInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw refuse('invalid-argument', 'INVALID', 'The request to cancel is not valid.');
  }
  const { tripId } = parsed.data;
  if (tripId.includes('/')) {
    throw refuse('invalid-argument', 'INVALID', 'The request to cancel is not valid.');
  }

  const { firestore } = deps;
  const userRef = firestore.collection('users').doc(caller.uid);
  const tripRef = firestore.collection('tripRequests').doc(tripId);

  return firestore.runTransaction(async (tx): Promise<CancelTripRequestResult> => {
    const [user, trip] = await Promise.all([tx.get(userRef), tx.get(tripRef)]);
    if (!trip.exists || trip.get('passengerId') !== caller.uid) {
      throw refuse('not-found', 'NOT_FOUND', 'That ride request was not found.');
    }

    const status: unknown = trip.get('status');
    if (status === 'CANCELLED') return { status: 'unchanged' };
    if (!canPassengerCancel(status)) {
      throw refuse(
        'failed-precondition',
        'NOT_CANCELLABLE',
        'This ride can no longer be cancelled here.',
      );
    }

    tx.update(tripRef, { status: 'CANCELLED', updatedAt: FieldValue.serverTimestamp() });
    if (user.exists && user.get('currentTripRequestId') === tripId) {
      tx.update(userRef, { currentTripRequestId: null, updatedAt: FieldValue.serverTimestamp() });
    }
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: 'TRIP_REQUEST_CANCELLED',
      entity: `tripRequests/${tripId}`,
      previousState: { status },
      newState: { status: 'CANCELLED' },
      reason: 'Passenger cancelled the request',
    });
    return { status: 'cancelled' };
  });
}

// How a request may move between statuses (spec section 73). Mirrors trip-request.ts in
// @ridemesh/types; tests/roles-parity.test.ts fails if they diverge.
export const TRIP_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  REQUESTED: ['SEARCHING', 'CANCELLED'],
  SEARCHING: ['MATCHED', 'CANCELLED'],
  MATCHED: ['PICKUP_ASSIGNED', 'CANCELLED'],
  PICKUP_ASSIGNED: ['DRIVER_ARRIVING', 'CANCELLED'],
  DRIVER_ARRIVING: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['IN_TRANSIT'],
  IN_TRANSIT: ['DROPOFF_APPROACHING'],
  DROPOFF_APPROACHING: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const PASSENGER_CANCELLABLE_STATUSES = ['REQUESTED', 'SEARCHING'] as const;

export function canTransition(from: unknown, to: unknown): boolean {
  const next = Object.hasOwn(TRIP_STATUS_TRANSITIONS, String(from))
    ? TRIP_STATUS_TRANSITIONS[String(from)]
    : undefined;
  return next !== undefined && next.includes(to as string);
}

export function canPassengerCancel(status: unknown): boolean {
  return (
    (PASSENGER_CANCELLABLE_STATUSES as readonly unknown[]).includes(status) &&
    canTransition(status, 'CANCELLED')
  );
}
