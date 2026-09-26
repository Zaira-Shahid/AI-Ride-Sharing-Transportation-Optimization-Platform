import { z } from 'zod';
import { flexibilityPreferencesSchema } from './flexibility';
import { destinationSchema, type StoredDestination } from './journey';
import type { PaymentStatus, TripRequestStatus } from './states';
import type { FirestoreTimestamp } from './user';
import type { VehicleType } from './vehicle';

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

/** Why the server refused to advance a request's pickup status (Module 7.2), as details.reason. */
export const TRIP_EXECUTION_REFUSALS = ['INVALID', 'NOT_FOUND', 'WRONG_STATUS'] as const;
export type TripExecutionRefusal = (typeof TRIP_EXECUTION_REFUSALS)[number];

/**
 * Advances the matched driver's own request `tripId` one step (headToPickup: PICKUP_ASSIGNED ->
 * DRIVER_ARRIVING; confirmPickup: DRIVER_ARRIVING -> PICKED_UP). Same shape for both - only the
 * function name and the transition it allows differ.
 */
export const advanceTripInputSchema = z.object({ tripId: z.string().min(1).max(200) });
export type AdvanceTripInput = z.infer<typeof advanceTripInputSchema>;

export interface AdvanceTripResult {
  status: 'updated' | 'unchanged';
}

export interface TripRequest {
  passengerId: string;
  /**
   * The passenger's first name only (never the full name or any other profile field), copied in at
   * creation so the driver they end up matched with (Module 7.1) can see who they are picking up
   * without needing read access to the passenger's own user profile.
   */
  passengerName: string;
  origin: StoredDestination;
  destination: StoredDestination;
  requestedAt: FirestoreTimestamp;
  /** When "leave now" was asked for, this is the moment of the request. */
  requestedDepartureTime: FirestoreTimestamp;
  arrivalDeadline: FirestoreTimestamp | null;
  status: TripRequestStatus;
  passengerPreferences: z.infer<typeof flexibilityPreferencesSchema>;
  /** Filled in by pricing (Phase 8 onwards); null until then. */
  estimatedFare: number | null;
  /**
   * How many candidate driver journeys matching found (Modules 5.2/5.3) when the request started
   * SEARCHING: null until then, and always for a request that has not left REQUESTED yet or was
   * future-dated (no candidates are looked for until closer to departure - a later module's
   * decision). A snapshot for a person to read, not a promise any of them are still available.
   */
  candidateCount: number | null;
  /** Who this request was assigned (Module 5.5), once its status is MATCHED; null until then. */
  matchedJourneyId: string | null;
  matchedDriverId: string | null;
  /**
   * The matched driver's first name only and their vehicle's details (Module 7.3), copied in at the
   * same moment as matchedDriverId so the passenger can recognise their ride without needing read
   * access to the driver's or vehicle's own profile - the same one-way snapshot pattern as
   * passengerName. Null until matched, and never updated afterwards even if the driver later edits
   * their name or vehicle.
   */
  driverName: string | null;
  vehicleType: VehicleType | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehiclePlateNumber: string | null;
  /**
   * Where the matched driver currently is (Module 7.6), copied in the same way every time
   * updateDriverLocation writes a new reading while this request is one of the journey's own
   * matchedTripRequestIds; null until the driver has shared a position. Powers the passenger's live
   * map and ETA - not updated once the request is COMPLETED or CANCELLED (nothing writes it after).
   */
  driverLocation: { latitude: number; longitude: number; accuracy: number | null } | null;
  /**
   * The road distance from the pickup to the destination in METRES, filled in by the server just after
   * the request is created (trip-estimate.ts); null until then, and when no route could be had.
   */
  estimatedDistance: number | null;
  /** The time for that route in whole SECONDS, without traffic; null like estimatedDistance. */
  estimatedDuration: number | null;
  assignedPlanId: string | null;
  /**
   * Whether this request's own journey ever had another matched passenger on it at the same time
   * (Module 6.9's own batch match, or Module 8.4's insertion into an already-matching journey - the
   * only two places a journey gains a second passenger). Set once, at match time; never re-derived
   * later, so a passenger dropped by a later re-plan still shows as having been on a shared ride.
   */
  sharedRide: boolean;
  /**
   * The fare the passenger actually owes (Module 9.3), filled in at trip completion from the same
   * estimatedDistance/estimatedDuration used throughout - sharedRideDiscountPercent taken off the
   * whole fare when sharedRide is true. Null until the trip is COMPLETED.
   */
  finalFareMinorUnits: number | null;
  /** The platform's own cut of finalFareMinorUnits (Module 9.3); null until finalFareMinorUnits is. */
  platformFeeMinorUnits: number | null;
  /**
   * Stripe's own reference for the hold placed at PICKUP_ASSIGNED (Module 9.2); null until an
   * authorization is attempted (which itself is not wired into the live match pipeline yet - see
   * paymentAuthorization.ts's own note).
   */
  paymentIntentId: string | null;
  /** AUTHORIZED (a hold placed), CAPTURED or FAILED (Module 9.4) - null until authorization is attempted. */
  paymentStatus: PaymentStatus | null;
  /** What was actually held (Module 9.2's own AUTHORIZATION_BUFFER_PERCENT over the estimate); null until authorized. */
  authorizedAmountMinorUnits: number | null;
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
  candidateCount: null,
  matchedJourneyId: null,
  matchedDriverId: null,
  driverName: null,
  vehicleType: null,
  vehicleMake: null,
  vehicleModel: null,
  vehiclePlateNumber: null,
  driverLocation: null,
  sharedRide: false,
  finalFareMinorUnits: null,
  platformFeeMinorUnits: null,
  paymentIntentId: null,
  paymentStatus: null,
  authorizedAmountMinorUnits: null,
} as const;

// How a trip request may move from one status to another (spec section 73: no arbitrary
// transitions). A request only ever moves along these arrows, and nothing leaves COMPLETED or
// CANCELLED. This is the starting set for the statuses the spec lists; the matching modules
// (Phase 5 onwards) are what move a request forward and may add arrows, and must do so here and in
// functions/src/tripRequests.ts (tests/roles-parity.test.ts fails if the two diverge).
export const TRIP_STATUS_TRANSITIONS: Record<TripRequestStatus, readonly TripRequestStatus[]> = {
  REQUESTED: ['SEARCHING', 'CANCELLED'],
  // PICKUP_ASSIGNED directly: the batch optimization run (Module 6.9/6.10, Phase 7) assigns a
  // request and fixes its place in the driver's stop order in the same step, so there is no separate
  // moment where it is "matched" but not yet "pickup assigned" - MATCHED stays a valid status (kept
  // for module 5.5's own still-exported assignSearchingTripRequest) but is not the only next step.
  SEARCHING: ['MATCHED', 'PICKUP_ASSIGNED', 'CANCELLED'],
  MATCHED: ['PICKUP_ASSIGNED', 'CANCELLED'],
  // SEARCHING too (Module 8.5, driver cancellation): the driver going offline before this passenger
  // is picked up releases them back to be matched again, rather than leaving them stranded on a
  // driver who never arrives.
  PICKUP_ASSIGNED: ['DRIVER_ARRIVING', 'SEARCHING', 'CANCELLED'],
  DRIVER_ARRIVING: ['PICKED_UP', 'SEARCHING', 'CANCELLED'],
  PICKED_UP: ['IN_TRANSIT'],
  IN_TRANSIT: ['DROPOFF_APPROACHING'],
  DROPOFF_APPROACHING: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** Whether a request may move from `from` to `to`. */
export function canTransition(from: unknown, to: unknown): boolean {
  const next = (TRIP_STATUS_TRANSITIONS as Record<string, readonly unknown[] | undefined>)[
    String(from)
  ];
  return next !== undefined && next.includes(to);
}

/**
 * The statuses a passenger may cancel from. Nothing is committed to a driver in either, so it is
 * free. From MATCHED onwards a cancellation needs a policy (fees, penalties) that comes with
 * payments, so it is not offered here.
 */
export const PASSENGER_CANCELLABLE_STATUSES = [
  'REQUESTED',
  'SEARCHING',
] as const satisfies readonly TripRequestStatus[];

/** Whether a passenger may cancel a request that is in `status`. */
export function canPassengerCancel(status: unknown): boolean {
  return (
    (PASSENGER_CANCELLABLE_STATUSES as readonly unknown[]).includes(status) &&
    canTransition(status, 'CANCELLED')
  );
}
