import {
  DRIVER_JOURNEY_STATUSES,
  type DeclareDestinationInput,
  type DeclareDestinationResult,
  type DriverJourneyStatus,
  type SetJourneyDetourInput,
  type SetJourneyDetourResult,
  type SetJourneyOriginInput,
  type SetJourneyOriginResult,
  type SetJourneySeatsInput,
  type SetJourneySeatsResult,
  type StoredDestination,
  type UpdateDriverLocationInput,
  type UpdateDriverLocationResult,
} from '@ridemesh/types';
import { doc, onSnapshot } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

export interface JourneyData {
  status: DriverJourneyStatus;
  destination: StoredDestination | null;
  /** Where the journey starts (the device's position, saved by the driver); null until saved. */
  origin: StoredDestination | null;
  /** Passenger seats on offer; null until the driver chooses. */
  availableSeats: number | null;
  /** Extra minutes the driver accepts for passengers; null until they choose. */
  maxDetourMinutes: number | null;
  /** Extra kilometres the driver accepts for passengers; null until they choose. */
  maxDetourDistance: number | null;
}

export type JourneySnapshot = { status: 'ready'; journey: JourneyData } | { status: 'missing' };

function readDestination(value: unknown): StoredDestination | null {
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

/** Follows driverJourneys/{id} live. A driver can read but never write their journey. */
export function subscribeToJourney(
  client: Pick<FirebaseClient, 'firestore'>,
  journeyId: string,
  onChange: (snapshot: JourneySnapshot) => void,
  onError: (error: unknown) => void,
): () => void {
  return onSnapshot(
    doc(client.firestore, 'driverJourneys', journeyId),
    (snapshot) => {
      if (!snapshot.exists()) {
        onChange({ status: 'missing' });
        return;
      }
      const data = snapshot.data();
      onChange({
        status: 'ready',
        journey: {
          // An unrecognised status is treated as a draft, the least advanced state.
          status: (DRIVER_JOURNEY_STATUSES as readonly unknown[]).includes(data.status)
            ? (data.status as DriverJourneyStatus)
            : 'DRAFT',
          destination: readDestination(data.destination),
          origin: readDestination(data.origin),
          availableSeats: Number.isInteger(data.availableSeats)
            ? (data.availableSeats as number)
            : null,
          maxDetourMinutes: Number.isInteger(data.maxDetourMinutes)
            ? (data.maxDetourMinutes as number)
            : null,
          maxDetourDistance: Number.isInteger(data.maxDetourDistance)
            ? (data.maxDetourDistance as number)
            : null,
        },
      });
    },
    onError,
  );
}

/**
 * Sets the signed-in driver's destination through the declareDestination function, which starts
 * their journey the first time. The place comes from the place search (@ridemesh/maps).
 */
export async function declareDestination(
  client: Pick<FirebaseClient, 'functions'>,
  destination: StoredDestination,
): Promise<DeclareDestinationResult['status']> {
  try {
    const result = await httpsCallable<DeclareDestinationInput, DeclareDestinationResult>(
      client.functions,
      'declareDestination',
    )({ destination });
    return result.data.status;
  } catch (error) {
    if (getErrorCode(error) === 'functions/failed-precondition') {
      throw new AuthFlowError(
        'permission',
        'You cannot set a destination right now. Add your vehicle first, then try again.',
      );
    }
    throw error;
  }
}

/**
 * Sets how many passenger seats the signed-in driver offers on their journey, through the
 * setJourneySeats function. It needs a destination and the vehicle's seats to be set first, and the
 * number can never be more than the vehicle holds.
 */
export async function setJourneySeats(
  client: Pick<FirebaseClient, 'functions'>,
  availableSeats: number,
): Promise<SetJourneySeatsResult['status']> {
  try {
    const result = await httpsCallable<SetJourneySeatsInput, SetJourneySeatsResult>(
      client.functions,
      'setJourneySeats',
    )({ availableSeats });
    return result.data.status;
  } catch (error) {
    const code = getErrorCode(error);
    if (code === 'functions/failed-precondition' || code === 'functions/invalid-argument') {
      throw new AuthFlowError(
        'permission',
        'You cannot set seats right now. Set your destination and vehicle seats first, then try again.',
      );
    }
    throw error;
  }
}

/**
 * Sets how far the signed-in driver will go out of their way on their journey, through the
 * setJourneyDetour function: extra minutes and extra kilometres, both set together. It needs a
 * destination first.
 */
export async function setJourneyDetour(
  client: Pick<FirebaseClient, 'functions'>,
  maxDetourMinutes: number,
  maxDetourDistanceKm: number,
): Promise<SetJourneyDetourResult['status']> {
  try {
    const result = await httpsCallable<SetJourneyDetourInput, SetJourneyDetourResult>(
      client.functions,
      'setJourneyDetour',
    )({ maxDetourMinutes, maxDetourDistance: maxDetourDistanceKm });
    return result.data.status;
  } catch (error) {
    const code = getErrorCode(error);
    if (code === 'functions/failed-precondition' || code === 'functions/invalid-argument') {
      throw new AuthFlowError(
        'permission',
        'You cannot set a detour right now. Set your destination first, then try again.',
      );
    }
    throw error;
  }
}

/**
 * Saves where the signed-in driver's journey starts: one reading of the device's position, through
 * the setJourneyOrigin function. It needs a destination first, and only a draft journey can change.
 */
export async function setJourneyOrigin(
  client: Pick<FirebaseClient, 'functions'>,
  origin: SetJourneyOriginInput['origin'],
  /** The address found for the position (reverseGeocode), when there is one. */
  address?: string | null,
): Promise<SetJourneyOriginResult['status']> {
  try {
    const result = await httpsCallable<SetJourneyOriginInput, SetJourneyOriginResult>(
      client.functions,
      'setJourneyOrigin',
    )({
      origin: { latitude: origin.latitude, longitude: origin.longitude },
      address: address ?? null,
    });
    return result.data.status;
  } catch (error) {
    const code = getErrorCode(error);
    if (code === 'functions/failed-precondition' || code === 'functions/invalid-argument') {
      throw new AuthFlowError(
        'permission',
        'You cannot set a start right now. Set your destination first, then try again.',
      );
    }
    throw error;
  }
}

/**
 * Sends one reading of the signed-in driver's position through the updateDriverLocation function.
 * The app decides how often (shouldSendLocation in @ridemesh/types); the server checks again, and
 * says what it did: 'updated', 'ignored' (too inaccurate) or 'throttled' (too soon after the last).
 * Only an online driver can share a position.
 */
export async function updateDriverLocation(
  client: Pick<FirebaseClient, 'functions'>,
  reading: UpdateDriverLocationInput,
): Promise<UpdateDriverLocationResult['status']> {
  try {
    const result = await httpsCallable<UpdateDriverLocationInput, UpdateDriverLocationResult>(
      client.functions,
      'updateDriverLocation',
    )({
      latitude: reading.latitude,
      longitude: reading.longitude,
      accuracy: reading.accuracy ?? null,
    });
    return result.data.status;
  } catch (error) {
    const code = getErrorCode(error);
    if (code === 'functions/failed-precondition' || code === 'functions/invalid-argument') {
      throw new AuthFlowError('permission', 'Your location could not be shared right now.');
    }
    throw error;
  }
}
