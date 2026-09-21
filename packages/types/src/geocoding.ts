import { z } from 'zod';

// Reverse geocoding (Module 4.2): turning a position from the device into an address, for the
// driver's start and a passenger's current-location pickup, which had none. The server asks
// Nominatim (OpenStreetMap) through one small provider interface, so Google can replace it later.
// Sending a position to a third party is a disclosure of a private person's location, so:
// - the position is ROUNDED before it leaves (roundForGeocoding: 4 decimals, about 11 m), and the
//   exact one stays in our own database;
// - answers are cached by the rounded position alone (never by user), which Nominatim's usage policy
//   asks for and which keeps repeat lookups away from a public server;
// - it is never required: when a lookup fails the app keeps "Current location".
// Mirrored in functions/src/geocoding.ts; tests/roles-parity.test.ts fails if they diverge.

/** Decimal places a position is rounded to before it is sent: 4 is about 11 metres. */
export const GEOCODE_DECIMALS = 4;

/**
 * The limits that protect Nominatim's public server (its policy allows at most one request a
 * second) and keep one caller from using them all. `globalSpacingMs` is the least time between two
 * requests from all callers together; `perCallerPerMinute` is how many lookups (not answered from
 * the cache) one person may cause in a minute.
 */
export const GEOCODE_LIMITS = {
  globalSpacingMs: 1_100,
  perCallerPerMinute: 10,
  /** How long the server waits for Nominatim before giving up (the app then keeps "Current location"). */
  providerTimeoutMs: 5_000,
} as const;

export interface GeocodePoint {
  latitude: number;
  longitude: number;
}

const roundTo = (value: number) => {
  const factor = 10 ** GEOCODE_DECIMALS;
  // "|| 0" turns a rounded -0 into 0, so 0 and -0 are one place.
  return Math.round(value * factor) / factor || 0;
};

/** The position as it is sent to the provider and cached: rounded to about 11 metres. */
export function roundForGeocoding(point: GeocodePoint): GeocodePoint {
  return { latitude: roundTo(point.latitude), longitude: roundTo(point.longitude) };
}

/** The cache document ID of a position: its rounded coordinates, and nothing about who asked. */
export function geocodeCacheKey(point: GeocodePoint): string {
  const rounded = roundForGeocoding(point);
  return `${rounded.latitude.toFixed(GEOCODE_DECIMALS)}_${rounded.longitude.toFixed(GEOCODE_DECIMALS)}`;
}

/** Exactly 0, 0 is what an unfilled position looks like; it is not a place (as for trip places). */
export const reverseGeocodeInputSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .refine((point) => !(point.latitude === 0 && point.longitude === 0));
export type ReverseGeocodeInput = z.infer<typeof reverseGeocodeInputSchema>;

/**
 * What the server found:
 * - found: `address` is the address of the spot
 * - none: the provider has no address for that spot (also cached, so it is not asked again)
 * - unavailable: the provider could not be reached or gave an answer that could not be used
 * - busy: too many lookups just now (the limits above); try again later
 * Only `found` carries an address.
 */
export type ReverseGeocodeStatus = 'found' | 'none' | 'unavailable' | 'busy';
export interface ReverseGeocodeResult {
  status: ReverseGeocodeStatus;
  address: string | null;
}
