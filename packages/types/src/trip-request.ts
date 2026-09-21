import { z } from 'zod';
import { flexibilityPreferencesSchema } from './flexibility';
import { destinationSchema, type StoredDestination } from './journey';
import type { TripRequestStatus } from './states';
import type { FirestoreTimestamp } from './user';

// tripRequests/{tripId} (spec section 10): what a passenger asked for. Created and changed only by
// server functions (Module 3.7); the passenger who made it can read it and nobody else can, not even
// staff (their access will come through audited functions). It holds exact pickup and destination
// coordinates of a private person, so it is never written to logs or audit entries (docs/security.md).

/** A trip request that has not ended: a passenger can have only one of these at a time. */
export const OPEN_TRIP_STATUSES = [
  'REQUESTED',
  'SEARCHING',
  'MATCHED',
  'PICKUP_ASSIGNED',
  'DRIVER_ARRIVING',
  'PICKED_UP',
  'IN_TRANSIT',
  'DROPOFF_APPROACHING',
] as const satisfies readonly TripRequestStatus[];

/** Whether a request is still open (not COMPLETED or CANCELLED). */
export function isOpenTripStatus(status: unknown): boolean {
  return (OPEN_TRIP_STATUSES as readonly unknown[]).includes(status);
}

/** When the passenger wants to leave, as sent to the server: now, or at an instant (ms since 1970, UTC). */
export const departureInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('NOW') }),
  z.object({ kind: z.literal('AT'), at: z.number() }),
]);

/**
 * What the app sends to createTripRequest. The pickup and destination are the places chosen; the
 * times are instants; the preferences are the ones a flexibility level gives (flexibilityPreferences).
 * The server checks all of it again with its own clock: nothing here is believed.
 */
export const createTripRequestInputSchema = z.object({
  origin: destinationSchema,
  destination: destinationSchema,
  departure: departureInputSchema,
  arriveBy: z.number().nullable(),
  preferences: flexibilityPreferencesSchema,
});
export type CreateTripRequestInput = z.infer<typeof createTripRequestInputSchema>;

export interface CreateTripRequestResult {
  tripId: string;
}

/** Why the server refused to create or cancel a request (sent as the error's details.reason). */
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

/** Cancels the passenger's request `tripId`. Only a REQUESTED one can be cancelled for now. */
export const cancelTripRequestInputSchema = z.object({ tripId: z.string().min(1).max(200) });
export type CancelTripRequestInput = z.infer<typeof cancelTripRequestInputSchema>;

export interface CancelTripRequestResult {
  status: 'cancelled' | 'unchanged';
}

export interface TripRequest {
  passengerId: string;
  origin: StoredDestination;
  destination: StoredDestination;
  requestedAt: FirestoreTimestamp;
  /** When "leave now" was asked for, this is the moment of the request. */
  requestedDepartureTime: FirestoreTimestamp;
  arrivalDeadline: FirestoreTimestamp | null;
  status: TripRequestStatus;
  passengerPreferences: z.infer<typeof flexibilityPreferencesSchema>;
  /** Filled in by routing and pricing (Phase 4 onwards); null until then. */
  estimatedFare: number | null;
  estimatedDistance: number | null;
  estimatedDuration: number | null;
  assignedPlanId: string | null;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
}

// What a new request starts with besides what the passenger sent and the timestamps. Mirrored in
// functions/src/tripRequests.ts; tests/roles-parity.test.ts fails if the two diverge.
export const NEW_TRIP_REQUEST_DEFAULTS = {
  status: 'REQUESTED',
  estimatedFare: null,
  estimatedDistance: null,
  estimatedDuration: null,
  assignedPlanId: null,
} as const;
