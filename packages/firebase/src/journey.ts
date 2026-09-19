import {
  DRIVER_JOURNEY_STATUSES,
  type DeclareDestinationInput,
  type DeclareDestinationResult,
  type DriverJourneyStatus,
  type StoredDestination,
} from '@ridemesh/types';
import { doc, onSnapshot } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

export interface JourneyData {
  status: DriverJourneyStatus;
  destination: StoredDestination | null;
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
