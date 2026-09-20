import { z } from 'zod';
import type { DriverJourneyStatus } from './states';
import type { FirestoreTimestamp } from './user';
import { SEAT_CAPACITY_MAX, SEAT_CAPACITY_MIN } from './vehicle';

export const DESTINATION_ADDRESS_MAX_LENGTH = 300;
export const PLACE_ID_MAX_LENGTH = 300;

/**
 * A place a driver is heading to: coordinates, the address Google shows for it, and its place ID
 * (spec section 8). Coordinates are what matching works with; the address is for people to read.
 */
export const destinationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  formattedAddress: z.string().trim().min(1).max(DESTINATION_ADDRESS_MAX_LENGTH),
  placeId: z.string().trim().min(1).max(PLACE_ID_MAX_LENGTH).nullish(),
});
export type DestinationInput = z.infer<typeof destinationSchema>;

/** A destination as stored: the place ID is null when there is none. */
export interface StoredDestination {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  placeId: string | null;
}

export const declareDestinationInputSchema = z.object({ destination: destinationSchema });
export type DeclareDestinationInput = z.infer<typeof declareDestinationInputSchema>;

export interface DeclareDestinationResult {
  status: 'created' | 'updated' | 'unchanged';
}

/**
 * How many passenger seats a driver offers on their journey. The vehicle's own capacity is the
 * upper limit, which only the server can check because it lives on another document.
 */
export const setJourneySeatsInputSchema = z.object({
  availableSeats: z.number().int().min(SEAT_CAPACITY_MIN).max(SEAT_CAPACITY_MAX),
});
export type SetJourneySeatsInput = z.infer<typeof setJourneySeatsInputSchema>;

export interface SetJourneySeatsResult {
  status: 'updated' | 'unchanged';
}

// driverJourneys/{journeyId} (spec section 10). A driver has at most one open journey, pointed to
// by drivers/{uid}.currentJourneyId. It starts as a DRAFT holding the destination; seats on offer
// (Module 2.7, never more than the vehicle's seatCapacity) and the detour limits (Module 2.8) are
// added to the same journey. Created and changed only by server-side code; clients can read their
// own but never write it.
export interface DriverJourney {
  driverId: string;
  /** The driver's vehicle, which has the same ID as the driver. */
  vehicleId: string;
  /** The driver's position at departure. Set from GPS in Phase 4; null until then. */
  origin: StoredDestination | null;
  destination: StoredDestination | null;
  departureTime: FirestoreTimestamp | null;
  availableSeats: number | null;
  maxDetourMinutes: number | null;
  maxDetourDistance: number | null;
  status: DriverJourneyStatus;
  currentLocation: StoredDestination | null;
  currentRoute: unknown;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
}

// What a new journey starts with besides driverId, vehicleId, destination and the timestamps.
// Mirrored in functions/src/journeys.ts; tests/roles-parity.test.ts fails if the two diverge.
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
