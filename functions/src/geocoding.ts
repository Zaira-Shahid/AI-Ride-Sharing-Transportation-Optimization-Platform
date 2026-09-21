import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import type { Caller } from './callers.js';

// Reverse geocoding (Module 4.2): a position from the device in, an address out. Functions deploy
// from this directory alone, so the numbers and helpers below mirror geocoding.ts in
// @ridemesh/types; tests/roles-parity.test.ts fails if they diverge. docs/security.md ("Reverse
// geocoding") explains the privacy choices: the position is rounded before it leaves, the answer
// is cached by that rounded position alone, and a failure is never an error for the person.

export const GEOCODE_DECIMALS = 4;
export const GEOCODE_LIMITS = {
  globalSpacingMs: 1_100,
  perCallerPerMinute: 10,
  providerTimeoutMs: 5_000,
} as const;
const ADDRESS_MAX_LENGTH = 300;

export interface GeocodePoint {
  latitude: number;
  longitude: number;
}

const roundTo = (value: number) => {
  const factor = 10 ** GEOCODE_DECIMALS;
  return Math.round(value * factor) / factor || 0;
};

export function roundForGeocoding(point: GeocodePoint): GeocodePoint {
  return { latitude: roundTo(point.latitude), longitude: roundTo(point.longitude) };
}

export function geocodeCacheKey(point: GeocodePoint): string {
  const rounded = roundForGeocoding(point);
  return `${rounded.latitude.toFixed(GEOCODE_DECIMALS)}_${rounded.longitude.toFixed(GEOCODE_DECIMALS)}`;
}

export const reverseGeocodeInputSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .refine((point) => !(point.latitude === 0 && point.longitude === 0));

export type ReverseGeocodeStatus = 'found' | 'none' | 'unavailable' | 'busy';
export type ReverseGeocodeResult = { status: ReverseGeocodeStatus; address: string | null };

/**
 * Whatever finds an address for a position. `null` means the provider has no address for that spot;
 * throwing means it could not be asked. Nominatim is the one implementation, and the only place that
 * knows about it, so Google (or a self-hosted server) can replace it without touching the rest.
 */
export interface GeocodingProvider {
  reverse(point: GeocodePoint): Promise<string | null>;
}

const firstOf = (address: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = address[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

/**
 * Writes an address the way a person would: "12 Some Street, Bristol, BS1 6QS". Nominatim's own
 * display_name is long (county, region, country) and is used only when the parts are missing.
 * Returns null when it says there is nothing there.
 */
export function formatNominatimAddress(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) throw new Error('Not an answer.');
  const answer = body as Record<string, unknown>;
  if (typeof answer.error === 'string') return null;

  const parts: string[] = [];
  const address =
    typeof answer.address === 'object' && answer.address !== null
      ? (answer.address as Record<string, unknown>)
      : {};
  const road = firstOf(address, ['road', 'pedestrian', 'footway', 'path', 'cycleway']);
  const number = firstOf(address, ['house_number']);
  // A house number means nothing without its street.
  const line = road ? [number, road].filter(Boolean).join(' ') : '';
  if (line) parts.push(line);
  const place = firstOf(address, ['city', 'town', 'village', 'hamlet', 'suburb', 'municipality']);
  if (place) parts.push(place);
  const postcode = firstOf(address, ['postcode']);
  if (postcode) parts.push(postcode);

  const text =
    parts.length > 0
      ? parts.join(', ')
      : typeof answer.display_name === 'string'
        ? answer.display_name.trim()
        : '';
  return text ? text.slice(0, ADDRESS_MAX_LENGTH) : null;
}

export interface NominatimConfig {
  /** Where Nominatim is: the public server by default, or a server of our own later. */
  baseUrl: string;
  /** Its usage policy asks for a User-Agent that identifies the application and how to reach it. */
  userAgent: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createNominatimProvider(config: NominatimConfig): GeocodingProvider {
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    async reverse(point) {
      // A server of our own may live under a path, so the path is added to, not replaced.
      const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/reverse`);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('lat', String(point.latitude));
      url.searchParams.set('lon', String(point.longitude));
      url.searchParams.set('zoom', '18');
      url.searchParams.set('addressdetails', '1');
      url.searchParams.set('accept-language', 'en');
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        config.timeoutMs ?? GEOCODE_LIMITS.providerTimeoutMs,
      );
      try {
        const response = await fetchImpl(url, {
          headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`The provider answered ${response.status}.`);
        return formatNominatimAddress(await response.json());
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The provider the deployed function uses, from its environment: NOMINATIM_BASE_URL (default the
 * public server) and GEOCODING_USER_AGENT. The public server's policy needs a User-Agent with a way
 * to contact us; that is an address only the owner can give, so it is configuration, not code, and
 * must be set before real use (docs/development.md).
 */
export function nominatimFromEnvironment(env: NodeJS.ProcessEnv = process.env): GeocodingProvider {
  return createNominatimProvider({
    baseUrl: env.NOMINATIM_BASE_URL?.trim() || 'https://nominatim.openstreetmap.org',
    userAgent: env.GEOCODING_USER_AGENT?.trim() || 'RideMesh (contact not configured)',
  });
}

export interface GeocodingLimits {
  globalSpacingMs: number;
  perCallerPerMinute: number;
}

/** The limits from the environment (the tests set the spacing to 0); the defaults are the policy's. */
export function limitsFromEnvironment(env: NodeJS.ProcessEnv = process.env): GeocodingLimits {
  const spacing = Number(env.GEOCODING_MIN_SPACING_MS);
  return {
    globalSpacingMs:
      env.GEOCODING_MIN_SPACING_MS?.trim() && Number.isFinite(spacing) && spacing >= 0
        ? spacing
        : GEOCODE_LIMITS.globalSpacingMs,
    perCallerPerMinute: GEOCODE_LIMITS.perCallerPerMinute,
  };
}

const WINDOW_MS = 60_000;

/**
 * Takes a place in line to ask the provider, or says there is none: the provider gets at most one
 * request every globalSpacingMs from everybody together, and one caller at most perCallerPerMinute
 * in a minute. Both counters are in Firestore, so they hold across function instances.
 */
async function claimLookup(
  firestore: Firestore,
  uid: string,
  now: number,
  limits: GeocodingLimits,
): Promise<boolean> {
  const callerRef = firestore.collection('geocodeLimits').doc(uid);
  const globalRef = firestore.collection('geocodeGlobal').doc('lookups');
  return firestore.runTransaction(async (tx) => {
    const [caller, global] = await Promise.all([tx.get(callerRef), tx.get(globalRef)]);
    const lastAt = global.get('lastAt');
    if (typeof lastAt === 'number' && now - lastAt < limits.globalSpacingMs) return false;

    const windowStart = caller.get('windowStart');
    const count = caller.get('count');
    const sameWindow =
      typeof windowStart === 'number' && typeof count === 'number' && now - windowStart < WINDOW_MS;
    if (sameWindow && count >= limits.perCallerPerMinute) return false;

    tx.set(
      callerRef,
      sameWindow ? { windowStart, count: count + 1 } : { windowStart: now, count: 1 },
    );
    tx.set(globalRef, { lastAt: now });
    return true;
  });
}

/**
 * Finds the address of a position for a signed-in, verified driver or passenger. The position is
 * rounded first (about 11 m); everything after that, the cache and the provider, sees only the
 * rounded one. An answer, including "there is no address here", is cached by the rounded position
 * alone, so a spot is asked about once and nobody's identity is stored with it. Only a lookup that
 * is not answered from the cache counts against the limits.
 *
 * A failure is not an error: the answer says `unavailable` or `busy` and the app keeps "Current
 * location". Nothing about the position is logged, and the provider's failure text (which could
 * contain the request) is not returned.
 */
export async function reverseGeocode(
  deps: {
    firestore: Firestore;
    provider: GeocodingProvider;
    limits?: GeocodingLimits;
    now?: () => number;
  },
  caller: Caller,
  rawInput: unknown,
): Promise<ReverseGeocodeResult> {
  if (!caller.emailVerified || (caller.role !== 'DRIVER' && caller.role !== 'PASSENGER')) {
    throw new HttpsError('permission-denied', 'Only verified drivers and passengers can do this.');
  }
  const parsed = reverseGeocodeInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The position is not valid.');
  }

  const { firestore, provider } = deps;
  const rounded = roundForGeocoding(parsed.data);
  const cacheRef = firestore.collection('geocodeCache').doc(geocodeCacheKey(rounded));

  const cached = await cacheRef.get();
  if (cached.exists) {
    const address: unknown = cached.get('address');
    return typeof address === 'string' && address
      ? { status: 'found', address }
      : { status: 'none', address: null };
  }

  const now = (deps.now ?? Date.now)();
  const limits = deps.limits ?? limitsFromEnvironment();
  // A lookup that cannot get its place in line (too many at once, or the counters could not be
  // updated) is simply busy: the person keeps "Current location".
  const claimed = await claimLookup(firestore, caller.uid, now, limits).catch(() => false);
  if (!claimed) return { status: 'busy', address: null };

  let address: string | null;
  try {
    address = await provider.reverse(rounded);
  } catch {
    // Not cached: it may work next time.
    return { status: 'unavailable', address: null };
  }

  await cacheRef.set({
    latitude: rounded.latitude,
    longitude: rounded.longitude,
    address,
    source: 'nominatim',
    fetchedAt: FieldValue.serverTimestamp(),
  });
  return address ? { status: 'found', address } : { status: 'none', address: null };
}
