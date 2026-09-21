import {
  DESTINATION_ADDRESS_MAX_LENGTH,
  PLACE_ID_MAX_LENGTH,
  type StoredDestination,
} from './journey';

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

/**
 * A pickup from the device's location: its coordinates and no place ID. Its address is the one
 * found for the position (reverse geocoding, Module 4.2) when there is one, and otherwise it says
 * what it is, CURRENT_LOCATION_ADDRESS.
 */
export function currentLocationPlace(
  point: { latitude: number; longitude: number },
  address?: string | null,
): StoredDestination {
  const found = address?.trim().slice(0, DESTINATION_ADDRESS_MAX_LENGTH);
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    formattedAddress: found ? found : CURRENT_LOCATION_ADDRESS,
    placeId: null,
  };
}

/**
 * Why a place cannot be a trip's pickup or destination, whatever the other one is:
 * - BAD_COORDINATES: a coordinate is missing, not a number, or outside the range of the earth
 * - NO_POSITION: exactly 0, 0 (in the ocean off Africa). No real place is there; it is what comes out
 *   when a position was never filled in, so it is treated as no position at all
 * - BAD_ADDRESS: the address is blank or longer than the limit
 * - BAD_PLACE_ID: a place ID is given but blank or longer than the limit
 */
export type PlaceProblem = 'BAD_COORDINATES' | 'NO_POSITION' | 'BAD_ADDRESS' | 'BAD_PLACE_ID';

/**
 * Checks that a place is well-formed enough to build a trip on: what the map, the driver and the
 * price will all rely on. Places from Google's search already pass through the same shape rules when
 * they are fetched (`destinationSchema`); this is the check at the point of use, and it also covers
 * the extra rule about 0, 0. It says nothing about where in the world the place is: there is no
 * service area (the trip may go anywhere), and whether a route exists is Phase 4's question.
 */
export function findPlaceProblem(place: StoredDestination): PlaceProblem | null {
  const { latitude, longitude, formattedAddress, placeId } = place;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return 'BAD_COORDINATES';
  }
  if (latitude === 0 && longitude === 0) return 'NO_POSITION';
  if (
    typeof formattedAddress !== 'string' ||
    formattedAddress.trim().length === 0 ||
    formattedAddress.length > DESTINATION_ADDRESS_MAX_LENGTH
  ) {
    return 'BAD_ADDRESS';
  }
  if (
    placeId !== null &&
    placeId !== undefined &&
    (typeof placeId !== 'string' ||
      placeId.trim().length === 0 ||
      placeId.length > PLACE_ID_MAX_LENGTH)
  ) {
    return 'BAD_PLACE_ID';
  }
  return null;
}

/** Why a place just chosen for a trip cannot be accepted. */
export type ChosenPlaceProblem = 'UNUSABLE' | 'SAME_AS_OTHER';

/**
 * Decides whether a place the passenger has just chosen (as the pickup or the destination) can be
 * accepted, given the other one if it has been chosen: it must be a usable place, and not the same
 * place as the other. The one check both choices go through. Module 3.7 must repeat it on the server.
 */
export function checkChosenPlace(
  place: StoredDestination,
  other: StoredDestination | null,
): ChosenPlaceProblem | null {
  if (findPlaceProblem(place) !== null) return 'UNUSABLE';
  if (other !== null && isSamePlace(place, other)) return 'SAME_AS_OTHER';
  return null;
}
