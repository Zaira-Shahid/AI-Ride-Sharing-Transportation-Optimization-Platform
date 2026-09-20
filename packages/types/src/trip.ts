import type { StoredDestination } from './journey';

// Rules about the places of a trip request. Module 3.7 creates the request on the server and must
// repeat the same-place rule there (functions cannot import this package, so it will be mirrored
// and checked by tests/roles-parity.test.ts, as the journey rules are).

/** Two places closer than this many metres count as the same place for a trip. */
export const SAME_PLACE_DISTANCE_METERS = 50;

/**
 * What a pickup taken from the device's location is called. There is no address for it (turning
 * coordinates into one is reverse geocoding, Phase 4), so it says what it is; the coordinates are
 * what the request carries.
 */
export const CURRENT_LOCATION_ADDRESS = 'Current location';

const EARTH_RADIUS_METERS = 6_371_008.8;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** The distance between two points along the earth's surface, in metres (haversine). */
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
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whether two places are the same place for a trip: the same Google place ID, or closer than
 * SAME_PLACE_DISTANCE_METERS. A pickup and a destination that are the same place make no trip, so
 * the request is refused. Places without an ID (a pickup from the device's location) are compared
 * by distance alone.
 */
export function isSamePlace(a: StoredDestination, b: StoredDestination): boolean {
  if (a.placeId && b.placeId && a.placeId === b.placeId) return true;
  return distanceMeters(a, b) < SAME_PLACE_DISTANCE_METERS;
}

/** A pickup from the device's location: its coordinates, with no place ID and no address. */
export function currentLocationPlace(point: {
  latitude: number;
  longitude: number;
}): StoredDestination {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    formattedAddress: CURRENT_LOCATION_ADDRESS,
    placeId: null,
  };
}
