import {
  TRIP_REQUEST_STATUSES,
  isOpenTripStatus,
  type CancelTripRequestInput,
  type CancelTripRequestResult,
  type CreateTripRequestInput,
  type CreateTripRequestResult,
  type FlexibilityLevel,
  type StoredDestination,
  type TripRequestRefusal,
  type TripRequestStatus,
} from '@ridemesh/types';
import { doc, onSnapshot, type Timestamp } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, type AuthErrorKind } from './auth-errors';
import type { FirebaseClient } from './client';

/** A passenger's open trip request, as the app shows it. Exact places stay on the device and screen. */
export interface TripRequestData {
  id: string;
  status: TripRequestStatus;
  origin: StoredDestination;
  destination: StoredDestination;
  /** When the passenger wants to leave, in ms since 1970; null while the server has not stamped it. */
  departureAt: number | null;
  /** The time the passenger must be there by, or null for no deadline. */
  arriveBy: number | null;
  flexibilityLevel: FlexibilityLevel | null;
  allowSharedRide: boolean;
}

export type TripRequestSnapshot = { status: 'none' } | { status: 'ready'; trip: TripRequestData };

const REFUSAL_MESSAGES: Record<TripRequestRefusal, { kind: AuthErrorKind; message: string }> = {
  INVALID: { kind: 'validation', message: 'The ride request was not accepted. Please check it.' },
  UNUSABLE_PLACE: {
    kind: 'validation',
    message: 'One of the places cannot be used. Choose again.',
  },
  SAME_PLACE: {
    kind: 'validation',
    message: 'The pickup and the destination are the same place. Choose a different one.',
  },
  TIME_INVALID: { kind: 'validation', message: 'That time is not valid. Choose another.' },
  TIME_TOO_SOON: { kind: 'validation', message: 'That time is too soon. Choose a later time.' },
  TIME_TOO_FAR: {
    kind: 'validation',
    message: 'That time is too far ahead. Choose an earlier time.',
  },
  ARRIVAL_NOT_AFTER_DEPARTURE: {
    kind: 'validation',
    message: 'The arrival time must be after the departure time.',
  },
  PREFERENCES: {
    kind: 'validation',
    message: 'Your flexibility choices were not accepted. Choose them again.',
  },
  ALREADY_OPEN: { kind: 'validation', message: 'You already have a ride requested.' },
  ACCOUNT: { kind: 'permission', message: 'This account cannot request a ride right now.' },
  NOT_FOUND: { kind: 'validation', message: 'That ride request was not found.' },
  NOT_CANCELLABLE: {
    kind: 'validation',
    message: 'This ride can no longer be cancelled here.',
  },
};

function refusalReason(error: unknown): TripRequestRefusal | null {
  if (typeof error !== 'object' || error === null || !('details' in error)) return null;
  const { details } = error as { details: unknown };
  if (typeof details !== 'object' || details === null) return null;
  const { reason } = details as { reason?: unknown };
  return typeof reason === 'string' && reason in REFUSAL_MESSAGES
    ? (reason as TripRequestRefusal)
    : null;
}

/** Turns the server's refusal into an error with a message a person can act on. */
function explainRefusal(error: unknown): unknown {
  const reason = refusalReason(error);
  if (reason === null) return error;
  const { kind, message } = REFUSAL_MESSAGES[reason];
  return new AuthFlowError(kind, message);
}

/**
 * Sends the passenger's ride request to the createTripRequest function, which checks it all again
 * (places, times, preferences) and creates it. Returns the new request's ID. A refusal comes back as
 * an AuthFlowError whose message says what to change.
 */
export async function createTripRequest(
  client: Pick<FirebaseClient, 'functions'>,
  input: CreateTripRequestInput,
): Promise<string> {
  try {
    const result = await httpsCallable<CreateTripRequestInput, CreateTripRequestResult>(
      client.functions,
      'createTripRequest',
    )(input);
    return result.data.tripId;
  } catch (error) {
    throw explainRefusal(error);
  }
}

/** Cancels the passenger's request through the cancelTripRequest function (REQUESTED only). */
export async function cancelTripRequest(
  client: Pick<FirebaseClient, 'functions'>,
  tripId: string,
): Promise<CancelTripRequestResult['status']> {
  try {
    const result = await httpsCallable<CancelTripRequestInput, CancelTripRequestResult>(
      client.functions,
      'cancelTripRequest',
    )({ tripId });
    return result.data.status;
  } catch (error) {
    throw explainRefusal(error);
  }
}

function readPlace(value: unknown): StoredDestination | null {
  if (typeof value !== 'object' || value === null) return null;
  const { latitude, longitude, formattedAddress, placeId } = value as Record<string, unknown>;
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    typeof formattedAddress !== 'string' ||
    formattedAddress.length === 0
  ) {
    return null;
  }
  return {
    latitude,
    longitude,
    formattedAddress,
    placeId: typeof placeId === 'string' && placeId ? placeId : null,
  };
}

function readMillis(value: unknown): number | null {
  return typeof value === 'object' && value !== null && 'toMillis' in value
    ? (value as Timestamp).toMillis()
    : null;
}

function readTrip(id: string, data: Record<string, unknown>): TripRequestData | null {
  const origin = readPlace(data.origin);
  const destination = readPlace(data.destination);
  if (!origin || !destination) return null;
  if (!(TRIP_REQUEST_STATUSES as readonly unknown[]).includes(data.status)) return null;
  const preferences =
    typeof data.passengerPreferences === 'object' && data.passengerPreferences !== null
      ? (data.passengerPreferences as Record<string, unknown>)
      : {};
  const level = preferences.flexibilityLevel;
  return {
    id,
    status: data.status as TripRequestStatus,
    origin,
    destination,
    departureAt: readMillis(data.requestedDepartureTime),
    arriveBy: readMillis(data.arrivalDeadline),
    flexibilityLevel:
      level === 'STRICT' || level === 'BALANCED' || level === 'FLEXIBLE' ? level : null,
    allowSharedRide: preferences.allowSharedRide === true,
  };
}

/**
 * Follows the signed-in passenger's open trip request live: users/{uid}.currentTripRequestId says
 * which one it is (only the server sets it), and tripRequests/{id} is followed while it is open.
 * Reports 'none' when there is no pointer, the request is gone or has ended.
 */
export function subscribeToCurrentTripRequest(
  client: Pick<FirebaseClient, 'firestore'>,
  uid: string,
  onChange: (snapshot: TripRequestSnapshot) => void,
  onError: (error: unknown) => void,
): () => void {
  // undefined until the first reading of the user, so that a first reading of "no request" is reported.
  let followedId: string | null | undefined;
  let stopTrip: (() => void) | null = null;

  const stopFollowingTrip = () => {
    stopTrip?.();
    stopTrip = null;
    followedId = undefined;
  };

  const stopUser = onSnapshot(
    doc(client.firestore, 'users', uid),
    (snapshot) => {
      const pointer: unknown = snapshot.exists() ? snapshot.get('currentTripRequestId') : null;
      const id = typeof pointer === 'string' && pointer ? pointer : null;
      if (id === followedId) return;
      stopFollowingTrip();
      if (id === null) {
        followedId = null;
        onChange({ status: 'none' });
        return;
      }
      followedId = id;
      stopTrip = onSnapshot(
        doc(client.firestore, 'tripRequests', id),
        (tripSnapshot) => {
          const trip = tripSnapshot.exists() ? readTrip(id, tripSnapshot.data()) : null;
          onChange(
            trip && isOpenTripStatus(trip.status) ? { status: 'ready', trip } : { status: 'none' },
          );
        },
        onError,
      );
    },
    onError,
  );

  return () => {
    stopUser();
    stopFollowingTrip();
  };
}
