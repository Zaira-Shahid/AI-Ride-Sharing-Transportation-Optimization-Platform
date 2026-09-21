import { z } from 'zod';
import { roundForGeocoding, type GeocodePoint } from './geocoding';

// Route calculation (Module 4.3): the distance, the time and the line of the road route through 2 to
// 10 stops, worked out by the server (calculateRoute) with OSRM behind one small provider interface,
// so Google can replace it later. The stops are private locations, so the rules are the ones of
// reverse geocoding (docs/security.md, "Route calculation"): stops are rounded to about 11 m in the
// app and again on the server before they leave, routes are cached by the rounded stops alone, the
// public server is spared by limits, and a failure is never an error for the person.
// Mirrored in functions/src/routing.ts; tests/roles-parity.test.ts fails if they diverge.

export const ROUTE_STOPS_MIN = 2;
export const ROUTE_STOPS_MAX = 10;

/** How a route is travelled. Walking arrives with Module 4.6, as one more entry here. */
export const ROUTE_PROFILES = ['driving'] as const;
export type RouteProfile = (typeof ROUTE_PROFILES)[number];

export const ROUTE_LIMITS = {
  /** The public server allows about one request a second, from everybody together. */
  globalSpacingMs: 1_100,
  /** How many routes (not answered from the cache) one person may cause in a minute. */
  perCallerPerMinute: 20,
  /** How long the server waits for OSRM before giving up. */
  providerTimeoutMs: 8_000,
  /**
   * How far, in metres, a stop may be from the nearest road. OSRM puts a stop that is not on a road on
   * the nearest one, however far that is (a point in the middle of the sea comes back as a road
   * hundreds of kilometres away, with a route that starts there), so a stop further than this from
   * a road is "no route" and not a route that does not start where the person is.
   */
  maxSnapMeters: 1_000,
} as const;

const stopSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  // Exactly 0, 0 is what an unfilled position looks like; it is not a place.
  .refine((point) => !(point.latitude === 0 && point.longitude === 0));

/** What the app sends to calculateRoute: the stops in the order they are visited. */
export const calculateRouteInputSchema = z.object({
  stops: z.array(stopSchema).min(ROUTE_STOPS_MIN).max(ROUTE_STOPS_MAX),
  profile: z.enum(ROUTE_PROFILES).nullish(),
});
export type CalculateRouteInput = z.infer<typeof calculateRouteInputSchema>;

/** One leg of a route: from a stop to the next. */
export interface RouteLeg {
  /** Metres, to the nearest metre. */
  distanceMeters: number;
  /** Seconds, to the nearest second. Free-flow time: OSRM has no traffic data. */
  durationSeconds: number;
}

export interface Route extends RouteLeg {
  /** The whole route as an encoded polyline (Google's format, 5 decimals), for drawing and later checks. */
  geometry: string;
  /** One leg between each two stops, in order. */
  legs: RouteLeg[];
}

/**
 * What the server found:
 * - found: `route` is the route
 * - none: there is no road route between those stops, or one of them is too far from any road
 *   (also cached, so it is not asked again)
 * - unavailable: the provider could not be reached or gave an answer that could not be used
 * - busy: too many lookups just now (the limits above); try again later
 * Only `found` carries a route.
 */
export type RouteStatus = 'found' | 'none' | 'unavailable' | 'busy';
export interface CalculateRouteResult {
  status: RouteStatus;
  route: Route | null;
}

/** The stops as they are sent: each rounded to about 11 m (see reverse geocoding). */
export function roundStopsForRouting(stops: readonly GeocodePoint[]): GeocodePoint[] {
  return stops.map(roundForGeocoding);
}
