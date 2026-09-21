import { z } from 'zod';
import { distanceMeters } from './trip';

// The driver's position (Module 4.1). Two things are stored, both on the driver's journey and both
// readable only by the driver and verified staff (docs/security.md, "Location"):
// - the journey's origin: one reading from the device that the driver saves on purpose, and
// - currentLocation: the latest position, written by updateDriverLocation only while the driver is
//   ONLINE, and cleared when they go offline.
// Spec section 72: never write GPS to Firestore every second; use adaptive updates, with intervals
// that are configurable and tested. The numbers below are those intervals, in one place.

export interface LocationThrottle {
  minIntervalMs: number;
  minDistanceMeters: number;
  heartbeatIntervalMs: number;
  maxAccuracyMeters: number;
  serverMinIntervalMs: number;
}

export const LOCATION_THROTTLE: LocationThrottle = {
  /** The app writes at most this often while the driver is moving... */
  minIntervalMs: 30_000,
  /** ...and only after moving at least this far since the last write. */
  minDistanceMeters: 50,
  /** A driver who has not moved is still written this often, so the position is known to be current. */
  heartbeatIntervalMs: 5 * 60_000,
  /** A reading less accurate than this (a larger radius, in metres) is not used at all. */
  maxAccuracyMeters: 100,
  /** The server refuses to write more often than this, whatever the app does: a safety net. */
  serverMinIntervalMs: 15_000,
};

/** What a place made from the device's reading is called (there is no address for a position). */
export const ORIGIN_ADDRESS = 'Current location';

const coordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/** Exactly 0, 0 is what an unfilled position looks like; it is not a place (as for trip places). */
const isRealPosition = (point: { latitude: number; longitude: number }) =>
  !(point.latitude === 0 && point.longitude === 0);

/** The driver's journey start: the device's position, saved once by the driver. */
export const setJourneyOriginInputSchema = z.object({
  origin: coordinateSchema.refine(isRealPosition),
});
export type SetJourneyOriginInput = z.infer<typeof setJourneyOriginInputSchema>;

export interface SetJourneyOriginResult {
  status: 'updated' | 'unchanged';
}

/** One reading sent while online. `accuracy` is the radius in metres, or null when unknown. */
export const updateDriverLocationInputSchema = coordinateSchema
  .extend({ accuracy: z.number().min(0).max(1_000_000).nullish() })
  .refine(isRealPosition);
export type UpdateDriverLocationInput = z.infer<typeof updateDriverLocationInputSchema>;

/**
 * What the server did with a reading: `updated` (written), `ignored` (too inaccurate to use) or
 * `throttled` (the last write was less than serverMinIntervalMs ago).
 */
export interface UpdateDriverLocationResult {
  status: 'updated' | 'ignored' | 'throttled';
}

/** Whether a reading is accurate enough to use. An unknown accuracy is accepted. */
export function isUsableAccuracy(
  accuracy: number | null | undefined,
  maxAccuracyMeters: number = LOCATION_THROTTLE.maxAccuracyMeters,
): boolean {
  if (accuracy === null || accuracy === undefined) return true;
  return Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= maxAccuracyMeters;
}

export interface LocationSample {
  latitude: number;
  longitude: number;
  /** When the reading was taken, in ms since 1970. */
  at: number;
  accuracy?: number | null | undefined;
}

/**
 * Whether the app should send this reading, given the last one that was sent (null when none has
 * been). Adaptive, as spec section 72 asks: a reading too inaccurate is never sent; the first
 * usable one is; then nothing sooner than minIntervalMs; then a reading is sent once the driver
 * has moved minDistanceMeters, or, if they have not moved, once heartbeatIntervalMs has passed.
 */
export function shouldSendLocation(
  last: LocationSample | null,
  next: LocationSample,
  throttle: LocationThrottle = LOCATION_THROTTLE,
): boolean {
  if (!isUsableAccuracy(next.accuracy, throttle.maxAccuracyMeters)) return false;
  if (last === null) return true;
  const elapsed = next.at - last.at;
  if (elapsed < throttle.minIntervalMs) return false;
  if (distanceMeters(last, next) >= throttle.minDistanceMeters) return true;
  return elapsed >= throttle.heartbeatIntervalMs;
}
