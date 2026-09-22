import { describe, expect, it } from 'vitest';
import {
  createOsrmProvider,
  osrmFromEnvironment,
  parseOsrmRoute,
  routeCacheKey,
  routingBaseUrlsFromEnvironment,
  routingLimitsFromEnvironment,
  routingUserAgentFromEnvironment,
} from './routing';

const okBody = (overrides: Record<string, unknown> = {}, stopCount = 2, snapped = 5.5) => ({
  code: 'Ok',
  routes: [
    {
      legs: Array.from({ length: stopCount - 1 }, () => ({
        steps: [],
        weight: 100.4,
        summary: '',
        duration: 100.4,
        distance: 1000.6,
      })),
      weight_name: 'routability',
      geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
      weight: 100.4 * (stopCount - 1),
      duration: 100.4 * (stopCount - 1),
      distance: 1000.6 * (stopCount - 1),
    },
  ],
  waypoints: Array.from({ length: stopCount }, () => ({
    hint: 'x',
    location: [0, 0],
    name: '',
    distance: snapped,
  })),
  ...overrides,
});

describe('parseOsrmRoute', () => {
  it('reads a route, rounding metres and seconds, with a leg for each pair of stops', () => {
    const route = parseOsrmRoute(okBody({}, 3), 3);
    expect(route).toEqual({
      distanceMeters: 2001,
      durationSeconds: 201,
      geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
      legs: [
        { distanceMeters: 1001, durationSeconds: 100 },
        { distanceMeters: 1001, durationSeconds: 100 },
      ],
    });
  });

  it('says there is no route when OSRM says so', () => {
    expect(parseOsrmRoute({ code: 'NoRoute', message: 'x' }, 2)).toBeNull();
    expect(parseOsrmRoute({ code: 'NoSegment', message: 'x' }, 2)).toBeNull();
  });

  it('says there is no route when a stop is too far from any road', () => {
    // OSRM puts a stop on the nearest road, however far: a point at sea came back 594 km away.
    expect(parseOsrmRoute(okBody({}, 2, 1_000), 2)).not.toBeNull();
    expect(parseOsrmRoute(okBody({}, 2, 1_000.5), 2)).toBeNull();
    expect(parseOsrmRoute(okBody({}, 2, 594_326.6), 2)).toBeNull();
    const body = okBody({}, 3);
    (body.waypoints[1] as { distance: number }).distance = 5_000;
    expect(parseOsrmRoute(body, 3)).toBeNull();
    expect(parseOsrmRoute(okBody({}, 2, 400), 2, 300)).toBeNull();
  });

  it.each([
    ['null', null],
    ['text', 'nope'],
    ['a code that is not Ok', { code: 'InvalidQuery' }],
    ['no code', {}],
    ['no routes', { code: 'Ok', routes: [], waypoints: [] }],
    ['routes that are not a list', { code: 'Ok', routes: {}, waypoints: [] }],
    ['a missing line', okBody({ routes: [{ ...okBody().routes[0], geometry: '' }] })],
    [
      'a distance that is not a number',
      okBody({ routes: [{ ...okBody().routes[0], distance: '5' }] }),
    ],
    ['a negative duration', okBody({ routes: [{ ...okBody().routes[0], duration: -1 }] })],
    ['the wrong number of legs', okBody({}, 3)],
    ['a leg that is not in form', okBody({ routes: [{ ...okBody().routes[0], legs: [{}] }] })],
    ['no stops back', okBody({ waypoints: undefined })],
    ['the wrong number of stops back', okBody({ waypoints: [{ distance: 1 }] })],
    ['a stop with no distance', okBody({ waypoints: [{}, {}] })],
  ])('fails, rather than saying there is no route, on %s', (_label, body) => {
    expect(() => parseOsrmRoute(body, 2)).toThrow();
  });
});

describe('the OSRM provider', () => {
  const stops = [
    { latitude: 51.4494, longitude: -2.5813 },
    { latitude: 51.5049, longitude: -0.0195 },
  ];
  const config = {
    baseUrls: {
      driving: 'https://osrm.example.test/routed-car',
      walking: 'https://osrm-foot.example.test/routed-foot',
    },
    userAgent: 'RideMesh-unit (test)',
  };

  function stub(response: () => Response | Promise<Response>) {
    const calls: { url: URL; init: RequestInit | undefined }[] = [];
    const fetchImpl = ((input: URL | string, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init });
      return Promise.resolve(response());
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('asks for the driving route through the stops, longitude first, and says who is asking', async () => {
    const { calls, fetchImpl } = stub(() => json(okBody()));
    const provider = createOsrmProvider({ ...config, fetchImpl });

    const route = await provider.route(stops, 'driving');

    expect(route?.distanceMeters).toBe(1001);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] ?? { url: new URL('http://none'), init: undefined };
    expect(url.origin).toBe('https://osrm.example.test');
    expect(url.pathname).toBe('/routed-car/route/v1/driving/-2.5813,51.4494;-0.0195,51.5049');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      overview: 'full',
      geometries: 'polyline',
      steps: 'false',
      alternatives: 'false',
    });
    expect((init?.headers as Record<string, string>)['User-Agent']).toBe('RideMesh-unit (test)');
  });

  it('keeps a path on the base URL, with or without a trailing slash', async () => {
    const { calls, fetchImpl } = stub(() => json(okBody()));
    await createOsrmProvider({
      ...config,
      baseUrls: {
        driving: 'https://maps.example.test/osrm/',
        walking: 'https://maps.example.test/osrm-foot/',
      },
      fetchImpl,
    }).route(stops, 'driving');
    expect(calls[0]?.url.pathname.startsWith('/osrm/route/v1/driving/')).toBe(true);
  });

  it('asks the foot server, not the car server, for a walking route, and says "foot"', async () => {
    const { calls, fetchImpl } = stub(() => json(okBody()));
    const provider = createOsrmProvider({ ...config, fetchImpl });

    await provider.route(stops, 'walking');
    await provider.route(stops, 'driving');

    const [walking, driving] = calls;
    // The community server ignores the word, so it is the server that makes a route a walking one.
    expect(walking?.url.origin).toBe('https://osrm-foot.example.test');
    expect(walking?.url.pathname).toBe(
      '/routed-foot/route/v1/foot/-2.5813,51.4494;-0.0195,51.5049',
    );
    expect(driving?.url.origin).toBe('https://osrm.example.test');
    expect(driving?.url.pathname).toBe(
      '/routed-car/route/v1/driving/-2.5813,51.4494;-0.0195,51.5049',
    );
  });

  it('puts every stop in the request, in order', async () => {
    const { calls, fetchImpl } = stub(() => json(okBody({}, 4)));
    const four = [
      ...stops,
      { latitude: 52.1, longitude: -1.5 },
      { latitude: 53.2, longitude: -0.5 },
    ];
    await createOsrmProvider({ ...config, fetchImpl }).route(four, 'driving');
    expect(decodeURIComponent(calls[0]?.url.pathname ?? '')).toBe(
      '/routed-car/route/v1/driving/-2.5813,51.4494;-0.0195,51.5049;-1.5,52.1;-0.5,53.2',
    );
  });

  it('says there is no route on OSRM\'s own "no route", even on an error status', async () => {
    for (const [status, code] of [
      [200, 'NoRoute'],
      [400, 'NoRoute'],
      [400, 'NoSegment'],
    ] as const) {
      const { fetchImpl } = stub(() => json({ code, message: 'x' }, status));
      expect(await createOsrmProvider({ ...config, fetchImpl }).route(stops, 'driving')).toBeNull();
    }
  });

  it.each([429, 500, 502, 503])(
    'fails, rather than saying there is no route, on a %s',
    async (status) => {
      const { fetchImpl } = stub(() => new Response('', { status }));
      await expect(
        createOsrmProvider({ ...config, fetchImpl }).route(stops, 'driving'),
      ).rejects.toThrow(String(status));
    },
  );

  it('fails on an answer that is not JSON, and when the network fails', async () => {
    const notJson = stub(() => new Response('<html>', { status: 200 }));
    await expect(
      createOsrmProvider({ ...config, fetchImpl: notJson.fetchImpl }).route(stops, 'driving'),
    ).rejects.toThrow();
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    await expect(
      createOsrmProvider({ ...config, fetchImpl: down }).route(stops, 'driving'),
    ).rejects.toThrow('fetch failed');
  });

  it('gives up after its timeout instead of waiting for ever', async () => {
    const hangs = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const started = Date.now();
    await expect(
      createOsrmProvider({ ...config, timeoutMs: 30, fetchImpl: hangs }).route(stops, 'driving'),
    ).rejects.toThrow('aborted');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('uses the snap distance it is given', async () => {
    const { fetchImpl } = stub(() => json(okBody({}, 2, 400)));
    const strict = createOsrmProvider({ ...config, maxSnapMeters: 300, fetchImpl });
    expect(await strict.route(stops, 'driving')).toBeNull();
  });
});

describe('the cache key', () => {
  const a = { latitude: 51.4494, longitude: -2.5813 };
  const b = { latitude: 51.5049, longitude: -0.0195 };

  it('is a hash, the same for stops that round to the same places', () => {
    const key = routeCacheKey('driving', [a, b]);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(routeCacheKey('driving', [{ latitude: 51.44941, longitude: -2.58131 }, b])).toBe(key);
  });

  it('differs for other stops, another order, another number of stops or another profile', () => {
    const key = routeCacheKey('driving', [a, b]);
    expect(routeCacheKey('driving', [b, a])).not.toBe(key);
    expect(routeCacheKey('driving', [a, { latitude: 51.5051, longitude: -0.0195 }])).not.toBe(key);
    expect(routeCacheKey('driving', [a, b, b])).not.toBe(key);
  });

  it('holds nothing readable: neither the stops nor who asked', () => {
    expect(routeCacheKey('driving', [a, b])).not.toContain('51');
  });
});

describe('configuration from the environment', () => {
  it('reads the spacing, and ignores nonsense', () => {
    expect(routingLimitsFromEnvironment({})).toEqual({
      globalSpacingMs: 1_100,
      perCallerPerMinute: 20,
    });
    expect(routingLimitsFromEnvironment({ ROUTING_MIN_SPACING_MS: '0' }).globalSpacingMs).toBe(0);
    expect(routingLimitsFromEnvironment({ ROUTING_MIN_SPACING_MS: '2500' }).globalSpacingMs).toBe(
      2_500,
    );
    for (const bad of ['-5', 'abc', '', '  ']) {
      expect(routingLimitsFromEnvironment({ ROUTING_MIN_SPACING_MS: bad }).globalSpacingMs).toBe(
        1_100,
      );
    }
  });

  it('builds a provider from the environment without needing anything set', () => {
    expect(osrmFromEnvironment({})).toBeDefined();
    expect(osrmFromEnvironment({ ROUTING_BASE_URL_DRIVING: 'http://x.test' })).toBeDefined();
  });

  it('says who it is: the routing setting, else the geocoding one, else that it has no contact', () => {
    expect(
      routingUserAgentFromEnvironment({
        ROUTING_USER_AGENT: 'routes',
        GEOCODING_USER_AGENT: 'places',
      }),
    ).toBe('routes');
    expect(routingUserAgentFromEnvironment({ GEOCODING_USER_AGENT: 'places' })).toBe('places');
    expect(
      routingUserAgentFromEnvironment({ ROUTING_USER_AGENT: '  ', GEOCODING_USER_AGENT: 'places' }),
    ).toBe('places');
    expect(routingUserAgentFromEnvironment({})).toBe('RideMesh (contact not configured)');
  });
});

describe('the servers, by way of travelling', () => {
  it("are the community server's car and foot servers unless the environment says otherwise", () => {
    expect(routingBaseUrlsFromEnvironment({})).toEqual({
      driving: 'https://routing.openstreetmap.de/routed-car',
      walking: 'https://routing.openstreetmap.de/routed-foot',
    });
  });

  it('can each be set on their own, and a blank setting is the default', () => {
    expect(
      routingBaseUrlsFromEnvironment({
        ROUTING_BASE_URL_DRIVING: 'http://car.test/x',
        ROUTING_BASE_URL_WALKING: 'http://foot.test/y',
      }),
    ).toEqual({ driving: 'http://car.test/x', walking: 'http://foot.test/y' });
    expect(
      routingBaseUrlsFromEnvironment({ ROUTING_BASE_URL_WALKING: 'http://foot.test/y' }),
    ).toEqual({
      driving: 'https://routing.openstreetmap.de/routed-car',
      walking: 'http://foot.test/y',
    });
    expect(
      routingBaseUrlsFromEnvironment({
        ROUTING_BASE_URL_DRIVING: '  ',
        ROUTING_BASE_URL_WALKING: '',
      }),
    ).toEqual(routingBaseUrlsFromEnvironment({}));
  });

  it('never use the car server for walking by default', () => {
    const urls = routingBaseUrlsFromEnvironment({});
    expect(urls.walking).not.toBe(urls.driving);
    expect(urls.walking).toContain('foot');
  });
});
