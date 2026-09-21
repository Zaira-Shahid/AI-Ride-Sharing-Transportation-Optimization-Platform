import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { requireVerifiedRider, type Caller } from './callers.js';
import { claimLookup, type LookupLimits } from './lookupLimits.js';

// Route calculation (Module 4.3): the distance, time and line of the road route through 2 to 10
// stops. Functions deploy from this directory alone, so the numbers and helpers below mirror
// routing.ts and geocoding.ts in @ridemesh/types; tests/roles-parity.test.ts fails if they diverge.
// docs/security.md ("Route calculation") explains the privacy choices, which are those of reverse
// geocoding: stops are rounded before they leave, routes are cached by the rounded stops alone, and
// a failure is never an error for the person.

export const GEOCODE_DECIMALS = 4;
export const ROUTE_STOPS_MIN = 2;
export const ROUTE_STOPS_MAX = 10;
export const ROUTE_PROFILES = ['driving'] as const;
export type RouteProfile = (typeof ROUTE_PROFILES)[number];

export const ROUTE_LIMITS = {
  globalSpacingMs: 1_100,
  perCallerPerMinute: 20,
  providerTimeoutMs: 8_000,
  maxSnapMeters: 1_000,
} as const;

export interface RoutePoint {
  latitude: number;
  longitude: number;
}

const roundTo = (value: number) => {
  const factor = 10 ** GEOCODE_DECIMALS;
  return Math.round(value * factor) / factor || 0;
};
export const roundStop = (point: RoutePoint): RoutePoint => ({
  latitude: roundTo(point.latitude),
  longitude: roundTo(point.longitude),
});
export const roundStopsForRouting = (stops: readonly RoutePoint[]): RoutePoint[] =>
  stops.map(roundStop);

const stopSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .refine((point) => !(point.latitude === 0 && point.longitude === 0));

export const calculateRouteInputSchema = z.object({
  stops: z.array(stopSchema).min(ROUTE_STOPS_MIN).max(ROUTE_STOPS_MAX),
  profile: z.enum(ROUTE_PROFILES).nullish(),
});

export interface RouteLeg {
  distanceMeters: number;
  durationSeconds: number;
}
export interface Route extends RouteLeg {
  geometry: string;
  legs: RouteLeg[];
}
export type RouteStatus = 'found' | 'none' | 'unavailable' | 'busy';
export type CalculateRouteResult = { status: RouteStatus; route: Route | null };

/**
 * Whatever works out a route. `null` means there is no route (no road between the stops, or a stop
 * too far from any road); throwing means it could not be asked. OSRM is the one implementation, and
 * the only place that knows about it, so Google (or a server of our own) replaces it without
 * touching the rest.
 */
export interface RoutingProvider {
  route(stops: RoutePoint[], profile: RouteProfile): Promise<Route | null>;
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Reads an OSRM answer for `stopCount` stops. Returns the route, or null when OSRM says there is no
 * route or a stop is further than maxSnapMeters from the road it was put on. Throws on anything that
 * is not what OSRM promises, which is a failure and not "no route". Distances are rounded to the
 * nearest metre and times to the nearest second; each leg is rounded on its own, so the legs may not
 * add up to the total by a metre or a second.
 */
export function parseOsrmRoute(
  body: unknown,
  stopCount: number,
  maxSnapMeters: number = ROUTE_LIMITS.maxSnapMeters,
): Route | null {
  if (typeof body !== 'object' || body === null) throw new Error('Not an answer.');
  const answer = body as Record<string, unknown>;
  if (answer.code === 'NoRoute' || answer.code === 'NoSegment') return null;
  if (answer.code !== 'Ok') throw new Error(`The provider answered ${String(answer.code)}.`);

  const route = Array.isArray(answer.routes) ? (answer.routes[0] as Record<string, unknown>) : null;
  if (
    !route ||
    !isNumber(route.distance) ||
    !isNumber(route.duration) ||
    typeof route.geometry !== 'string' ||
    route.geometry.length === 0 ||
    !Array.isArray(route.legs) ||
    route.legs.length !== stopCount - 1
  ) {
    throw new Error('The route is not in the expected form.');
  }
  const legs = route.legs.map((leg: unknown): RouteLeg => {
    const { distance, duration } = (leg ?? {}) as Record<string, unknown>;
    if (!isNumber(distance) || !isNumber(duration) || distance < 0 || duration < 0) {
      throw new Error('A leg is not in the expected form.');
    }
    return { distanceMeters: Math.round(distance), durationSeconds: Math.round(duration) };
  });
  if (route.distance < 0 || route.duration < 0)
    throw new Error('The route is not in the expected form.');

  const waypoints = answer.waypoints;
  if (!Array.isArray(waypoints) || waypoints.length !== stopCount) {
    throw new Error('The stops are not in the expected form.');
  }
  for (const waypoint of waypoints) {
    const snapped = (waypoint as Record<string, unknown> | null)?.distance;
    if (!isNumber(snapped)) throw new Error('A stop is not in the expected form.');
    // OSRM puts a stop on the nearest road however far that is. Too far means there is no route from
    // where the person is.
    if (snapped > maxSnapMeters) return null;
  }

  return {
    distanceMeters: Math.round(route.distance),
    durationSeconds: Math.round(route.duration),
    geometry: route.geometry,
    legs,
  };
}

export interface OsrmConfig {
  /** Where OSRM is for each way of travelling (a server of our own later; a path is allowed). */
  baseUrls: Record<RouteProfile, string>;
  /** Its usage policy asks for a User-Agent that identifies the application and how to reach it. */
  userAgent: string;
  timeoutMs?: number;
  maxSnapMeters?: number;
  fetchImpl?: typeof fetch;
}

export function createOsrmProvider(config: OsrmConfig): RoutingProvider {
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    async route(stops, profile) {
      // OSRM takes longitude first, and the stops as one list.
      const coordinates = stops.map((stop) => `${stop.longitude},${stop.latitude}`).join(';');
      const base = config.baseUrls[profile].replace(/\/+$/, '');
      const url = new URL(`${base}/route/v1/${profile}/${coordinates}`);
      url.searchParams.set('overview', 'full');
      url.searchParams.set('geometries', 'polyline');
      url.searchParams.set('steps', 'false');
      url.searchParams.set('alternatives', 'false');
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        config.timeoutMs ?? ROUTE_LIMITS.providerTimeoutMs,
      );
      try {
        const response = await fetchImpl(url, {
          headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
          signal: controller.signal,
        });
        // OSRM may answer "no route" with an error status and a JSON body, so read the body first.
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const code = (body as { code?: unknown } | null)?.code;
          if (code === 'NoRoute' || code === 'NoSegment') return null;
          throw new Error(`The provider answered ${response.status}.`);
        }
        return parseOsrmRoute(body, stops.length, config.maxSnapMeters);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The provider the deployed function uses, from its environment: ROUTING_BASE_URL_DRIVING (default
 * the community server routing.openstreetmap.de, which has separate car, foot and bike servers) and
 * ROUTING_USER_AGENT, which falls back to GEOCODING_USER_AGENT so the one contact is set once. The
 * server's policy needs a User-Agent with a way to contact us (docs/development.md).
 */
/** Who the function says it is: the routing setting, else the geocoding one, else that it has no contact. */
export function routingUserAgentFromEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.ROUTING_USER_AGENT?.trim() ||
    env.GEOCODING_USER_AGENT?.trim() ||
    'RideMesh (contact not configured)'
  );
}

export function osrmFromEnvironment(env: NodeJS.ProcessEnv = process.env): RoutingProvider {
  return createOsrmProvider({
    baseUrls: {
      driving:
        env.ROUTING_BASE_URL_DRIVING?.trim() || 'https://routing.openstreetmap.de/routed-car',
    },
    userAgent: routingUserAgentFromEnvironment(env),
  });
}

/** The limits from the environment (the tests set the spacing to 0); the defaults are the policy's. */
export function routingLimitsFromEnvironment(env: NodeJS.ProcessEnv = process.env): LookupLimits {
  const spacing = Number(env.ROUTING_MIN_SPACING_MS);
  return {
    globalSpacingMs:
      env.ROUTING_MIN_SPACING_MS?.trim() && Number.isFinite(spacing) && spacing >= 0
        ? spacing
        : ROUTE_LIMITS.globalSpacingMs,
    perCallerPerMinute: ROUTE_LIMITS.perCallerPerMinute,
  };
}

/**
 * The cache document ID of a route: a hash of the way of travelling and the rounded stops, in order.
 * It holds nothing about who asked, and nothing exact.
 */
export function routeCacheKey(profile: RouteProfile, stops: readonly RoutePoint[]): string {
  const text = `${profile}|${stops
    .map(
      (stop) =>
        `${roundStop(stop).latitude.toFixed(GEOCODE_DECIMALS)},${roundStop(stop).longitude.toFixed(GEOCODE_DECIMALS)}`,
    )
    .join(';')}`;
  return createHash('sha256').update(text).digest('hex');
}

/** A route whose line is longer than this is answered but not cached (a document is at most 1 MiB). */
export const MAX_CACHED_GEOMETRY_LENGTH = 700_000;

/**
 * Works out the road route through the stops, for a signed-in, verified driver or passenger. The
 * stops are rounded first (about 11 m); everything after that, the cache and the provider, sees only
 * the rounded ones. A route, including "there is no route", is cached by the rounded stops alone, so
 * nobody's identity is stored with it. Only a lookup that is not answered from the cache counts
 * against the limits. There is no traffic in the times: they are free-flow estimates.
 *
 * A failure is not an error: the answer says `unavailable` or `busy`. Nothing about the stops is
 * logged, and the provider's failure text is not returned.
 */
export async function calculateRoute(
  deps: {
    firestore: Firestore;
    provider: RoutingProvider;
    limits?: LookupLimits;
    now?: () => number;
  },
  caller: Caller,
  rawInput: unknown,
): Promise<CalculateRouteResult> {
  requireVerifiedRider(caller);
  const parsed = calculateRouteInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The stops are not valid.');
  }

  const { firestore, provider } = deps;
  const profile: RouteProfile = parsed.data.profile ?? 'driving';
  const stops = roundStopsForRouting(parsed.data.stops);
  const cacheRef = firestore.collection('routeCache').doc(routeCacheKey(profile, stops));

  const cached = await cacheRef.get();
  if (cached.exists) {
    const route: unknown = cached.get('route');
    return typeof route === 'object' && route !== null
      ? { status: 'found', route: route as Route }
      : { status: 'none', route: null };
  }

  const now = (deps.now ?? Date.now)();
  const limits = deps.limits ?? routingLimitsFromEnvironment();
  const claimed = await claimLookup(
    firestore,
    { perCaller: 'routeLimits', global: 'routeGlobal' },
    caller.uid,
    now,
    limits,
  ).catch(() => false);
  if (!claimed) return { status: 'busy', route: null };

  let route: Route | null;
  try {
    route = await provider.route(stops, profile);
  } catch {
    // Not cached: it may work next time.
    return { status: 'unavailable', route: null };
  }

  if (!route || route.geometry.length <= MAX_CACHED_GEOMETRY_LENGTH) {
    await cacheRef.set({
      profile,
      stops,
      route,
      source: 'osrm',
      fetchedAt: FieldValue.serverTimestamp(),
    });
  }
  return route ? { status: 'found', route } : { status: 'none', route: null };
}
