import { destinationSchema, type StoredDestination } from '@ridemesh/types';

// Google Places API (New), called straight from the app with a restricted API key: autocomplete
// while the person types, then one details request for the place they pick. Both use the same
// session token so Google bills them as one session.
const PLACES_BASE_URL = 'https://places.googleapis.com/v1';
const DETAILS_FIELDS = 'id,formattedAddress,location';

export const PLACE_SEARCH_MIN_LENGTH = 2;
export const PLACE_SEARCH_MAX_LENGTH = 200;

export type PlacesErrorKind =
  /** No API key was configured for this build. */
  | 'not-configured'
  /** The request did not get through, or Google was unavailable. Worth trying again. */
  | 'network'
  /** Google refused the request (a bad or restricted key, quota, an invalid request). */
  | 'rejected'
  | 'not-found'
  /** Google answered with something this app does not understand. */
  | 'unexpected';

/** A failure a person can be told about in general terms. Never contains the API key. */
export class PlacesError extends Error {
  readonly kind: PlacesErrorKind;

  constructor(kind: PlacesErrorKind, message: string) {
    super(message);
    this.name = 'PlacesError';
    this.kind = kind;
  }
}

export interface PlacesOptions {
  /** The restricted Maps Platform key for this app. Undefined when none was configured. */
  apiKey: string | undefined;
  /** Only for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface PlaceSuggestion {
  placeId: string;
  /** The whole line to show, for example "10 Downing Street, London, UK". */
  text: string;
  /** The name of the place, when Google splits it out. */
  primary: string;
  secondary: string | null;
}

const SESSION_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A new autocomplete session: use it for every search and the one details call that follows. */
export function createSessionToken(): string {
  let token = '';
  for (let index = 0; index < 32; index += 1) {
    token += SESSION_CHARS[Math.floor(Math.random() * SESSION_CHARS.length)];
  }
  return token;
}

function requireKey(options: PlacesOptions): string {
  const key = options.apiKey?.trim();
  if (!key) throw new PlacesError('not-configured', 'Place search is not set up.');
  return key;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function send(options: PlacesOptions, url: string, init: RequestInit): Promise<unknown> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(url, init);
  } catch (error) {
    // A cancelled search (the person kept typing) is not a failure; let the caller see it.
    if (isAbort(error)) throw error;
    throw new PlacesError('network', 'Could not reach the place search.');
  }

  if (response.status === 404) throw new PlacesError('not-found', 'That place was not found.');
  if (response.status === 429 || response.status >= 500) {
    throw new PlacesError('network', 'The place search is busy. Try again in a moment.');
  }
  if (!response.ok) throw new PlacesError('rejected', 'The place search was refused.');

  try {
    return await response.json();
  } catch {
    throw new PlacesError('unexpected', 'The place search gave an unexpected answer.');
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(value: unknown): string | undefined {
  const text = asRecord(value)?.text;
  return typeof text === 'string' && text.trim().length > 0 ? text.trim() : undefined;
}

/**
 * Suggests places for what the person has typed so far. Returns nothing, without asking Google,
 * until there are at least two characters.
 */
export async function searchPlaces(
  options: PlacesOptions,
  input: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<PlaceSuggestion[]> {
  const apiKey = requireKey(options);
  const query = input.trim().slice(0, PLACE_SEARCH_MAX_LENGTH);
  if (query.length < PLACE_SEARCH_MIN_LENGTH) return [];

  const body = await send(options, `${PLACES_BASE_URL}/places:autocomplete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ input: query, sessionToken }),
    ...(signal ? { signal } : {}),
  });

  const suggestions = asRecord(body)?.suggestions;
  if (suggestions === undefined) return [];
  if (!Array.isArray(suggestions)) {
    throw new PlacesError('unexpected', 'The place search gave an unexpected answer.');
  }

  const places: PlaceSuggestion[] = [];
  for (const suggestion of suggestions) {
    // Google can also return query suggestions, which have no place to pick.
    const prediction = asRecord(asRecord(suggestion)?.placePrediction);
    const placeId = prediction?.placeId;
    const text = textOf(prediction?.text);
    if (typeof placeId !== 'string' || placeId.length === 0 || !text) continue;

    const format = asRecord(prediction?.structuredFormat);
    places.push({
      placeId,
      text,
      primary: textOf(format?.mainText) ?? text,
      secondary: textOf(format?.secondaryText) ?? null,
    });
  }
  return places;
}

/**
 * The coordinates, address and place ID of a picked place, ready to be declared as a destination.
 * Only the three fields needed are requested; Google bills details by the fields asked for.
 */
export async function getPlaceDestination(
  options: PlacesOptions,
  placeId: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<StoredDestination> {
  const apiKey = requireKey(options);
  const url = `${PLACES_BASE_URL}/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(sessionToken)}`;

  const body = await send(options, url, {
    method: 'GET',
    headers: { 'x-goog-api-key': apiKey, 'x-goog-fieldmask': DETAILS_FIELDS },
    ...(signal ? { signal } : {}),
  });

  const place = asRecord(body);
  const location = asRecord(place?.location);
  const parsed = destinationSchema.safeParse({
    latitude: location?.latitude,
    longitude: location?.longitude,
    formattedAddress: place?.formattedAddress,
    placeId: typeof place?.id === 'string' ? place.id : placeId,
  });
  if (!parsed.success) {
    throw new PlacesError('unexpected', 'The place search gave an unexpected answer.');
  }
  return { ...parsed.data, placeId: parsed.data.placeId ?? null };
}
