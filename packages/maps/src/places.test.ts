import { describe, expect, it, vi } from 'vitest';
import {
  PlacesError,
  createSessionToken,
  getPlaceDestination,
  searchPlaces,
  type PlacesOptions,
} from './places';

const KEY = 'test-key-123';

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function options(response: Response | Error) {
  const fetchMock = vi.fn<typeof fetch>(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const placesOptions: PlacesOptions = { apiKey: KEY, fetch: fetchMock };
  return { placesOptions, fetchMock };
}

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject.');
}

const OFFICE = {
  suggestions: [
    {
      placePrediction: {
        placeId: 'place-1',
        text: { text: 'Canary Wharf, London, UK' },
        structuredFormat: {
          mainText: { text: 'Canary Wharf' },
          secondaryText: { text: 'London, UK' },
        },
      },
    },
  ],
};

describe('createSessionToken', () => {
  it('makes a fresh 32-character token each time', () => {
    const first = createSessionToken();
    expect(first).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(createSessionToken()).not.toBe(first);
  });
});

describe('searchPlaces', () => {
  it('asks Places (New) with the key in a header, never in the URL', async () => {
    const { placesOptions, fetchMock } = options(reply(OFFICE));
    await searchPlaces(placesOptions, '  Canary  ', 'session-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://places.googleapis.com/v1/places:autocomplete');
    expect(url).not.toContain(KEY);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'x-goog-api-key': KEY });
    expect(JSON.parse(init.body as string)).toEqual({ input: 'Canary', sessionToken: 'session-1' });
  });

  it('returns the suggestions with the name and the rest of the address', async () => {
    const { placesOptions } = options(reply(OFFICE));
    expect(await searchPlaces(placesOptions, 'Canary', 's')).toEqual([
      {
        placeId: 'place-1',
        text: 'Canary Wharf, London, UK',
        primary: 'Canary Wharf',
        secondary: 'London, UK',
      },
    ]);
  });

  it('falls back to the full text when Google gives no split', async () => {
    const { placesOptions } = options(
      reply({ suggestions: [{ placePrediction: { placeId: 'p', text: { text: 'Somewhere' } } }] }),
    );
    expect(await searchPlaces(placesOptions, 'Some', 's')).toEqual([
      { placeId: 'p', text: 'Somewhere', primary: 'Somewhere', secondary: null },
    ]);
  });

  it('skips query suggestions and malformed entries', async () => {
    const { placesOptions } = options(
      reply({
        suggestions: [
          { queryPrediction: { text: { text: 'coffee near me' } } },
          { placePrediction: { placeId: '', text: { text: 'No id' } } },
          { placePrediction: { placeId: 'p', text: { text: '   ' } } },
          { placePrediction: { text: { text: 'No id at all' } } },
          null,
          ...OFFICE.suggestions,
        ],
      }),
    );
    const results = await searchPlaces(placesOptions, 'Canary', 's');
    expect(results.map((place) => place.placeId)).toEqual(['place-1']);
  });

  it('returns nothing when Google has no suggestions', async () => {
    const { placesOptions } = options(reply({}));
    expect(await searchPlaces(placesOptions, 'zzzz', 's')).toEqual([]);
  });

  it.each(['', ' ', 'a', ' a '])('does not ask Google about %j', async (input) => {
    const { placesOptions, fetchMock } = options(reply(OFFICE));
    expect(await searchPlaces(placesOptions, input, 's')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cuts very long input down', async () => {
    const { placesOptions, fetchMock } = options(reply(OFFICE));
    await searchPlaces(placesOptions, 'x'.repeat(500), 's');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).input).toHaveLength(200);
  });

  it.each([undefined, '', '   '])('says it is not set up when the key is %j', async (apiKey) => {
    const fetchMock = vi.fn();
    const error = await failureOf(
      searchPlaces({ apiKey, fetch: fetchMock as unknown as typeof fetch }, 'Canary', 's'),
    );
    expect(error).toBeInstanceOf(PlacesError);
    expect((error as PlacesError).kind).toBe('not-configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'rejected'],
    [401, 'rejected'],
    [403, 'rejected'],
    [429, 'network'],
    [500, 'network'],
    [503, 'network'],
  ])('reports HTTP %s as %s', async (status, kind) => {
    const { placesOptions } = options(reply({ error: { message: 'secret detail' } }, status));
    const error = (await failureOf(searchPlaces(placesOptions, 'Canary', 's'))) as PlacesError;
    expect(error.kind).toBe(kind);
    expect(error.message).not.toContain('secret detail');
    expect(error.message).not.toContain(KEY);
  });

  it('reports a request that never arrived as a network problem', async () => {
    const { placesOptions } = options(new TypeError('Failed to fetch'));
    const error = (await failureOf(searchPlaces(placesOptions, 'Canary', 's'))) as PlacesError;
    expect(error.kind).toBe('network');
  });

  it('lets a cancelled search pass through so the caller can ignore it', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    const { placesOptions } = options(abort);
    const error = await failureOf(searchPlaces(placesOptions, 'Canary', 's'));
    expect(error).toBe(abort);
  });

  it('reports an answer that is not JSON, or has the wrong shape, as unexpected', async () => {
    const notJson = options(new Response('<html>', { status: 200 }));
    expect(
      ((await failureOf(searchPlaces(notJson.placesOptions, 'Canary', 's'))) as PlacesError).kind,
    ).toBe('unexpected');

    const wrongShape = options(reply({ suggestions: 'nope' }));
    expect(
      ((await failureOf(searchPlaces(wrongShape.placesOptions, 'Canary', 's'))) as PlacesError)
        .kind,
    ).toBe('unexpected');
  });
});

describe('getPlaceDestination', () => {
  const PLACE = {
    id: 'place-1',
    formattedAddress: '1 Canada Square, London E14 5AB, UK',
    location: { latitude: 51.5049, longitude: -0.0195 },
  };

  it('asks for only the fields it needs, and puts the key in a header', async () => {
    const { placesOptions, fetchMock } = options(reply(PLACE));
    await getPlaceDestination(placesOptions, 'place-1', 'session-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://places.googleapis.com/v1/places/place-1?sessionToken=session-1');
    expect(url).not.toContain(KEY);
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      'x-goog-api-key': KEY,
      'x-goog-fieldmask': 'id,formattedAddress,location',
    });
  });

  it('returns coordinates, address and place ID', async () => {
    const { placesOptions } = options(reply(PLACE));
    expect(await getPlaceDestination(placesOptions, 'place-1', 's')).toEqual({
      latitude: 51.5049,
      longitude: -0.0195,
      formattedAddress: '1 Canada Square, London E14 5AB, UK',
      placeId: 'place-1',
    });
  });

  it('keeps the place ID it was asked for when Google omits it', async () => {
    const withoutId = { formattedAddress: PLACE.formattedAddress, location: PLACE.location };
    const { placesOptions } = options(reply(withoutId));
    expect((await getPlaceDestination(placesOptions, 'asked-for', 's')).placeId).toBe('asked-for');
  });

  it('escapes the place ID in the URL', async () => {
    const { placesOptions, fetchMock } = options(reply(PLACE));
    await getPlaceDestination(placesOptions, 'a/b?c', 's');
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/places/a%2Fb%3Fc?');
  });

  it.each([
    ['no location', { ...PLACE, location: undefined }],
    ['a latitude out of range', { ...PLACE, location: { latitude: 95, longitude: 0 } }],
    ['a longitude out of range', { ...PLACE, location: { latitude: 0, longitude: 190 } }],
    ['coordinates as text', { ...PLACE, location: { latitude: '51', longitude: '0' } }],
    ['no address', { ...PLACE, formattedAddress: undefined }],
    ['a blank address', { ...PLACE, formattedAddress: '  ' }],
    ['an oversized address', { ...PLACE, formattedAddress: 'x'.repeat(301) }],
  ])('refuses an answer with %s', async (_label, body) => {
    const { placesOptions } = options(reply(body));
    const error = (await failureOf(getPlaceDestination(placesOptions, 'p', 's'))) as PlacesError;
    expect(error.kind).toBe('unexpected');
  });

  it('reports an unknown place, a refusal and no key', async () => {
    const missing = options(reply({}, 404));
    expect(
      ((await failureOf(getPlaceDestination(missing.placesOptions, 'p', 's'))) as PlacesError).kind,
    ).toBe('not-found');

    const refused = options(reply({}, 403));
    expect(
      ((await failureOf(getPlaceDestination(refused.placesOptions, 'p', 's'))) as PlacesError).kind,
    ).toBe('rejected');

    const noKey = await failureOf(getPlaceDestination({ apiKey: undefined }, 'p', 's'));
    expect((noKey as PlacesError).kind).toBe('not-configured');
  });
});
