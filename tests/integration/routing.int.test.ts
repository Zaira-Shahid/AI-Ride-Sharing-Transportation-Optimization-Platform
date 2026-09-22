import { httpsCallable } from 'firebase/functions';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  calculateRoute as calculateRouteForApp,
  type RouteOutcome,
} from '../../packages/firebase/src';
import {
  MAX_CACHED_GEOMETRY_LENGTH,
  calculateRoute,
  routeCacheKey,
  type Route,
  type RoutePoint,
  type RouteProfile,
  type RoutingProvider,
} from '../../functions/src/routing';
import type { LookupLimits } from '../../functions/src/lookupLimits';
import { defaultRouteBody, startFakeOsrm, type FakeOsrm } from '../fake-osrm';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

// Two ways in, as for reverse geocoding. The logic (the rounding, the cache, the limits, the
// failures) is tested by calling the function with a stand-in provider against the real Firestore
// emulator, which is quick and can control the clock. The rest goes through the real callable on the
// Functions emulator, which asks a fake OSRM (tests/fake-osrm.ts, found through
// functions/.env.demo-ridemesh), to prove the wiring: the environment, the request that leaves, and
// what comes back.

const rider = (uid = 'rider-1', role: string = 'PASSENGER', emailVerified = true) => ({
  uid,
  role,
  emailVerified,
});
const NO_LIMITS: LookupLimits = { globalSpacingMs: 0, perCallerPerMinute: 1_000 };

/** A different, distant pair of stops for every test, so the cache from one never answers another. */
let counter = 0;
const newStops = (count = 2): RoutePoint[] => {
  counter += 1;
  return Array.from({ length: count }, (_unused, i) => ({
    latitude: 20 + counter * 0.1 + i * 0.01,
    longitude: 30 + counter * 0.1 + i * 0.01,
  }));
};

const ROUTE: Route = {
  distanceMeters: 12_345,
  durationSeconds: 901,
  geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
  legs: [{ distanceMeters: 12_345, durationSeconds: 901 }],
};

function stubProvider(answer: Route | null | Error = ROUTE) {
  const calls: { stops: RoutePoint[]; profile: string }[] = [];
  const provider: RoutingProvider = {
    route: (stops, profile) => {
      calls.push({ stops, profile });
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer);
    },
  };
  return { provider, calls };
}

const cacheDoc = async (stops: RoutePoint[], profile: RouteProfile = 'driving') =>
  (
    await admin()
      .firestore.doc(`routeCache/${routeCacheKey(profile, stops)}`)
      .get()
  ).data();
const limitsDoc = async (uid: string) =>
  (await admin().firestore.doc(`routeLimits/${uid}`).get()).data();

async function clearRoutingState() {
  const { firestore } = admin();
  for (const name of ['routeCache', 'routeLimits', 'routeGlobal']) {
    await firestore.recursiveDelete(firestore.collection(name));
  }
}

let fake: FakeOsrm;
beforeAll(async () => {
  fake = await startFakeOsrm();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  await clearRoutingState();
  fake.requests.length = 0;
  fake.reply(null);
});

describe('calculateRoute: what the provider sees, and what is stored', () => {
  it('finds the route, asks the provider about the rounded stops only, and caches it', async () => {
    const { provider, calls } = stubProvider();
    const exact = [
      { latitude: 51.44941234, longitude: -2.58139876 },
      { latitude: 51.50494321, longitude: -0.01949999 },
    ];

    const result = await calculateRoute(
      { firestore: admin().firestore, provider, limits: NO_LIMITS },
      rider(),
      { stops: exact },
    );

    expect(result).toEqual({ status: 'found', route: ROUTE });
    // The exact stops never left: the provider was given them rounded to 4 decimals, as driving.
    expect(calls).toEqual([
      {
        stops: [
          { latitude: 51.4494, longitude: -2.5814 },
          { latitude: 51.5049, longitude: -0.0195 },
        ],
        profile: 'driving',
      },
    ]);
    const stored = await cacheDoc(calls[0]?.stops ?? []);
    expect(stored).toMatchObject({ profile: 'driving', route: ROUTE, source: 'osrm' });
    expect(stored?.stops).toEqual(calls[0]?.stops);
    expect(stored?.fetchedAt).toBeDefined();
    // Nothing about who asked, and nothing exact, is in the cache.
    expect(Object.keys(stored ?? {}).sort()).toEqual(
      ['fetchedAt', 'profile', 'route', 'source', 'stops'].sort(),
    );
    const text = JSON.stringify(stored);
    for (const secret of ['rider-1', '51.44941234', '2.58139876', '51.50494321', '0.01949999']) {
      expect(text).not.toContain(secret);
    }
  });

  it('answers from the cache, for anyone, without asking the provider or using up a limit', async () => {
    const { provider, calls } = stubProvider();
    const stops = newStops();
    const deps = { firestore: admin().firestore, provider, limits: NO_LIMITS };
    await calculateRoute(deps, rider('first'), { stops });

    const again = await calculateRoute(deps, rider('second', 'DRIVER'), { stops });

    expect(again).toEqual({ status: 'found', route: ROUTE });
    expect(calls).toHaveLength(1);
    expect(await limitsDoc('second')).toBeUndefined();
  });

  it('treats stops that round to the same places as one route, and another order as another', async () => {
    const { provider, calls } = stubProvider();
    const deps = { firestore: admin().firestore, provider, limits: NO_LIMITS };
    const [a, b] = newStops();
    if (!a || !b) throw new Error('stops');

    await calculateRoute(deps, rider(), { stops: [a, b] });
    const nearby = [
      { latitude: a.latitude + 0.00001, longitude: a.longitude - 0.00001 },
      { latitude: b.latitude - 0.00001, longitude: b.longitude + 0.00001 },
    ];
    expect((await calculateRoute(deps, rider(), { stops: nearby })).status).toBe('found');
    expect(calls).toHaveLength(1);

    await calculateRoute(deps, rider(), { stops: [b, a] });
    expect(calls).toHaveLength(2);
  });

  it('accepts 10 stops, and asks about them all in order', async () => {
    const { provider, calls } = stubProvider();
    const stops = newStops(10);

    await calculateRoute({ firestore: admin().firestore, provider, limits: NO_LIMITS }, rider(), {
      stops,
    });

    expect(calls[0]?.stops).toHaveLength(10);
  });

  it('takes an explicit driving profile, or none, as the same route', async () => {
    const { provider, calls } = stubProvider();
    const stops = newStops();
    const deps = { firestore: admin().firestore, provider, limits: NO_LIMITS };

    await calculateRoute(deps, rider(), { stops, profile: 'driving' });
    await calculateRoute(deps, rider(), { stops, profile: null });
    await calculateRoute(deps, rider(), { stops });

    expect(calls).toHaveLength(1);
  });

  it('takes a walking profile, and asks the provider for a walking route', async () => {
    const { provider, calls } = stubProvider();
    const stops = newStops();

    await calculateRoute({ firestore: admin().firestore, provider, limits: NO_LIMITS }, rider(), {
      stops,
      profile: 'walking',
    });

    expect(calls.map((call) => call.profile)).toEqual(['walking']);
    expect((await cacheDoc(calls[0]?.stops ?? [], 'walking'))?.profile).toBe('walking');
  });

  it('keeps a walking route and a driving route between the same stops apart', async () => {
    const { provider, calls } = stubProvider();
    const stops = newStops();
    const deps = { firestore: admin().firestore, provider, limits: NO_LIMITS };

    await calculateRoute(deps, rider(), { stops });
    // The road route is not the answer to a walking question: it is asked again, and cached on its own.
    await calculateRoute(deps, rider(), { stops, profile: 'walking' });
    expect(calls.map((call) => call.profile)).toEqual(['driving', 'walking']);
    expect(routeCacheKey('driving', stops)).not.toBe(routeCacheKey('walking', stops));

    // Now each is answered from the cache.
    await calculateRoute(deps, rider(), { stops });
    await calculateRoute(deps, rider(), { stops, profile: 'walking' });
    expect(calls).toHaveLength(2);
    expect((await cacheDoc(calls[0]?.stops ?? [], 'driving'))?.profile).toBe('driving');
    expect((await cacheDoc(calls[1]?.stops ?? [], 'walking'))?.profile).toBe('walking');
  });

  it('counts walking and driving lookups against the same limits', async () => {
    const { provider } = stubProvider();
    const limits: LookupLimits = { globalSpacingMs: 0, perCallerPerMinute: 2 };
    const deps = { firestore: admin().firestore, provider, limits, now: () => 3_000_000 };

    expect((await calculateRoute(deps, rider('mix'), { stops: newStops() })).status).toBe('found');
    expect(
      (await calculateRoute(deps, rider('mix'), { stops: newStops(), profile: 'walking' })).status,
    ).toBe('found');
    // Two lookups, one of each: a third, of either kind, is over the caller's limit.
    expect(
      (await calculateRoute(deps, rider('mix'), { stops: newStops(), profile: 'walking' })).status,
    ).toBe('busy');
    expect((await calculateRoute(deps, rider('mix'), { stops: newStops() })).status).toBe('busy');
  });

  it('caches "no route here" too, so those stops are not asked about again', async () => {
    const { provider, calls } = stubProvider(null);
    const stops = newStops();
    const deps = { firestore: admin().firestore, provider, limits: NO_LIMITS };

    expect(await calculateRoute(deps, rider(), { stops })).toEqual({ status: 'none', route: null });
    expect(await calculateRoute(deps, rider(), { stops })).toEqual({ status: 'none', route: null });

    expect(calls).toHaveLength(1);
    expect((await cacheDoc(calls[0]?.stops ?? []))?.route).toBeNull();
  });

  it('does not cache a failure, and the next try asks again', async () => {
    const failing = stubProvider(new Error('The provider answered 503.'));
    const stops = newStops();
    const firestore = admin().firestore;

    const first = await calculateRoute(
      { firestore, provider: failing.provider, limits: NO_LIMITS },
      rider(),
      { stops },
    );
    expect(first).toEqual({ status: 'unavailable', route: null });
    expect(JSON.stringify(first)).not.toContain('503');

    const working = stubProvider();
    const second = await calculateRoute(
      { firestore, provider: working.provider, limits: NO_LIMITS },
      rider(),
      { stops },
    );
    expect(second).toEqual({ status: 'found', route: ROUTE });
    expect(working.calls).toHaveLength(1);
  });

  it('answers a route whose line is too long to store, and does not store it', async () => {
    const huge: Route = { ...ROUTE, geometry: 'x'.repeat(MAX_CACHED_GEOMETRY_LENGTH + 1) };
    const { provider, calls } = stubProvider(huge);
    const stops = newStops();
    const deps = { firestore: admin().firestore, provider, limits: NO_LIMITS };

    expect((await calculateRoute(deps, rider(), { stops })).status).toBe('found');

    expect(await cacheDoc(calls[0]?.stops ?? [])).toBeUndefined();
    // It is asked for again, since nothing was kept; a normal route is kept.
    await calculateRoute(deps, rider(), { stops });
    expect(calls).toHaveLength(2);
  });
});

describe('calculateRoute: the limits', () => {
  it('lets one caller cause only so many routes in a minute, and others carry on', async () => {
    const { provider, calls } = stubProvider();
    const limits: LookupLimits = { globalSpacingMs: 0, perCallerPerMinute: 3 };
    const clock = { now: 1_000_000 };
    const deps = { firestore: admin().firestore, provider, limits, now: () => clock.now };

    for (let i = 0; i < 3; i += 1) {
      expect((await calculateRoute(deps, rider('busy'), { stops: newStops() })).status).toBe(
        'found',
      );
    }
    expect(await calculateRoute(deps, rider('busy'), { stops: newStops() })).toEqual({
      status: 'busy',
      route: null,
    });
    expect(calls).toHaveLength(3);

    expect((await calculateRoute(deps, rider('other'), { stops: newStops() })).status).toBe(
      'found',
    );
    clock.now += 61_000;
    expect((await calculateRoute(deps, rider('busy'), { stops: newStops() })).status).toBe('found');
  });

  it('does not count routes answered from the cache against the caller', async () => {
    const { provider } = stubProvider();
    const limits: LookupLimits = { globalSpacingMs: 0, perCallerPerMinute: 2 };
    const deps = { firestore: admin().firestore, provider, limits };
    const stops = newStops();
    await calculateRoute(deps, rider('cached'), { stops });

    for (let i = 0; i < 6; i += 1) {
      expect((await calculateRoute(deps, rider('cached'), { stops })).status).toBe('found');
    }
    expect(await limitsDoc('cached')).toMatchObject({ count: 1 });
  });

  it('keeps the provider to one request every 1.1 seconds for everybody together', async () => {
    const { provider, calls } = stubProvider();
    const limits: LookupLimits = { globalSpacingMs: 1_100, perCallerPerMinute: 100 };
    const clock = { now: 5_000_000 };
    const deps = { firestore: admin().firestore, provider, limits, now: () => clock.now };

    expect((await calculateRoute(deps, rider('a'), { stops: newStops() })).status).toBe('found');
    clock.now += 500;
    expect(await calculateRoute(deps, rider('b'), { stops: newStops() })).toEqual({
      status: 'busy',
      route: null,
    });
    clock.now += 599;
    expect((await calculateRoute(deps, rider('b'), { stops: newStops() })).status).toBe('busy');
    clock.now += 1;
    expect((await calculateRoute(deps, rider('b'), { stops: newStops() })).status).toBe('found');
    expect(calls).toHaveLength(2);
  });

  it('does not share its counters with reverse geocoding', async () => {
    const { provider } = stubProvider();
    const limits: LookupLimits = { globalSpacingMs: 60_000, perCallerPerMinute: 100 };
    const deps = { firestore: admin().firestore, provider, limits, now: () => 9_000_000 };
    await admin().firestore.doc('geocodeGlobal/lookups').set({ lastAt: 9_000_000 });

    // An address lookup a moment ago does not make a route wait, and the other way round.
    expect((await calculateRoute(deps, rider(), { stops: newStops() })).status).toBe('found');
    expect((await admin().firestore.doc('geocodeGlobal/lookups').get()).get('lastAt')).toBe(
      9_000_000,
    );
  });

  it('caches nothing and asks nobody when it is busy', async () => {
    const { provider, calls } = stubProvider();
    const limits: LookupLimits = { globalSpacingMs: 60_000, perCallerPerMinute: 100 };
    const deps = { firestore: admin().firestore, provider, limits, now: () => 9_000_000 };
    await calculateRoute(deps, rider('a'), { stops: newStops() });
    const stops = newStops();

    expect((await calculateRoute(deps, rider('b'), { stops })).status).toBe('busy');

    expect(calls).toHaveLength(1);
    expect(await cacheDoc(stops)).toBeUndefined();
  });

  it('stays correct when many arrive at once: the provider is asked once per slot', async () => {
    const { provider, calls } = stubProvider();
    const limits: LookupLimits = { globalSpacingMs: 60_000, perCallerPerMinute: 100 };
    const deps = { firestore: admin().firestore, provider, limits, now: () => 7_000_000 };

    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        calculateRoute(deps, rider(`c${i}`), { stops: newStops() }),
      ),
    );

    expect(results.filter((result) => result.status === 'found')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'busy')).toHaveLength(7);
    expect(calls).toHaveLength(1);
  });
});

describe('calculateRoute: who may ask, and what', () => {
  it('is for verified drivers and passengers only', async () => {
    const { provider, calls } = stubProvider();
    const deps = { firestore: admin().firestore, provider, limits: NO_LIMITS };
    const stops = newStops();

    for (const caller of [
      rider('x', 'ADMIN'),
      rider('x', 'SUPER_ADMIN'),
      rider('x', 'SUPPORT'),
      rider('x', 'nonsense'),
      rider('x', ''),
      rider('x', 'PASSENGER', false),
      rider('x', 'DRIVER', false),
    ]) {
      await expect(calculateRoute(deps, caller, { stops })).rejects.toMatchObject({
        code: 'permission-denied',
      });
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['no stops', { stops: [] }],
    ['one stop', { stops: newStops(1) }],
    ['11 stops', { stops: newStops(11) }],
    ['a stop at 0, 0', { stops: [...newStops(1), { latitude: 0, longitude: 0 }] }],
    ['a latitude out of range', { stops: [...newStops(1), { latitude: 91, longitude: 0 }] }],
    ['text for a number', { stops: [...newStops(1), { latitude: '51', longitude: 0 }] }],
    ['a profile that does not exist', { stops: newStops(), profile: 'cycling' }],
    ['stops that are not a list', { stops: 'abc' }],
    ['nothing', null],
  ])('refuses %s and asks nobody', async (_label, input) => {
    const { provider, calls } = stubProvider();

    await expect(
      calculateRoute({ firestore: admin().firestore, provider, limits: NO_LIMITS }, rider(), input),
    ).rejects.toMatchObject({ code: 'invalid-argument' });

    expect(calls).toHaveLength(0);
  });
});

describe('the calculateRoute callable (functions + firestore emulators, fake OSRM)', () => {
  async function person(role: 'DRIVER' | 'PASSENGER', prefix: string, verified = true) {
    const client = createClient();
    const { user, uid, email } = await signUp(client, prefix);
    await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
    if (verified) await verifyEmail(user, email);
    else await user.getIdToken(true);
    return { client, uid };
  }
  const call = (client: Client, data: unknown) =>
    httpsCallable(client.functions, 'calculateRoute')(data).then((result) => result.data);

  const A = { latitude: 51.44941234, longitude: -2.58139876 };
  const B = { latitude: 51.50494321, longitude: -0.01949999 };

  it('asks the provider named in the environment, as itself, about the rounded stops', async () => {
    const { client } = await person('PASSENGER', 'route-callable');

    const result = (await call(client, { stops: [A, B] })) as {
      status: string;
      route: Route;
    };

    expect(result.status).toBe('found');
    expect(result.route.distanceMeters).toBeGreaterThan(150_000);
    expect(result.route.distanceMeters).toBeLessThan(400_000);
    expect(result.route.durationSeconds).toBeGreaterThan(0);
    expect(result.route.legs).toHaveLength(1);
    expect(result.route.legs[0]?.distanceMeters).toBe(result.route.distanceMeters);
    expect(result.route.geometry.length).toBeGreaterThan(0);

    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request?.stops).toEqual([
      { latitude: 51.4494, longitude: -2.5814 },
      { latitude: 51.5049, longitude: -0.0195 },
    ]);
    expect(request?.path).toBe('/routed-car/route/v1/driving/-2.5814,51.4494;-0.0195,51.5049');
    // No traffic: one plain route, with its line, and nothing else asked for.
    expect(Object.fromEntries(request?.search ?? [])).toEqual({
      overview: 'full',
      geometries: 'polyline',
      steps: 'false',
      alternatives: 'false',
    });
    // It says who it is with the one contact setting (geocoding's), since routing has none of its own.
    expect(request?.headers['user-agent']).toBe('RideMesh-tests');
    expect(request?.path).not.toContain('44941234');
  });

  it('answers a second request for the same stops from the cache, for anybody', async () => {
    const first = await person('PASSENGER', 'route-cache-1');
    const second = await person('DRIVER', 'route-cache-2');

    await call(first.client, { stops: [A, B] });
    const again = (await call(second.client, {
      stops: [
        { latitude: 51.44943, longitude: -2.58141 },
        { latitude: 51.50492, longitude: -0.01951 },
      ],
    })) as { status: string };

    expect(again.status).toBe('found');
    expect(fake.requests).toHaveLength(1);
  });

  it('asks the foot server for a walking route, and gets a walking pace', async () => {
    const { client } = await person('PASSENGER', 'route-walk');
    const stops = [
      { latitude: 51.5049, longitude: -0.0195 },
      { latitude: 51.507, longitude: -0.025 },
    ];

    const walking = (await call(client, { stops, profile: 'walking' })) as {
      status: string;
      route: Route;
    };
    const driving = (await call(client, { stops })) as { status: string; route: Route };

    expect(walking.status).toBe('found');
    expect(driving.status).toBe('found');
    // The two questions went to the two servers, each with its own word for the way of travelling.
    expect(fake.requests.map((request) => [request.profile, request.path.split('/')[1]])).toEqual([
      ['walking', 'routed-foot'],
      ['driving', 'routed-car'],
    ]);
    expect(fake.requests[0]?.path).toBe('/routed-foot/route/v1/foot/-0.0195,51.5049;-0.025,51.507');
    expect(fake.requests[1]?.path).toBe(
      '/routed-car/route/v1/driving/-0.0195,51.5049;-0.025,51.507',
    );
    // On foot the same trip is slow: walking pace is about 1.25 m/s, a car's about 14 m/s.
    const walkingPace = walking.route.distanceMeters / walking.route.durationSeconds;
    const drivingPace = driving.route.distanceMeters / driving.route.durationSeconds;
    expect(walkingPace).toBeGreaterThan(1);
    expect(walkingPace).toBeLessThan(2);
    expect(drivingPace).toBeGreaterThan(10);
  });

  it('answers a second walking request for the same stops from the cache', async () => {
    const first = await person('PASSENGER', 'route-walk-cache-1');
    const second = await person('DRIVER', 'route-walk-cache-2');
    const stops = [
      { latitude: 51.5049, longitude: -0.0195 },
      { latitude: 51.507, longitude: -0.025 },
    ];

    await call(first.client, { stops, profile: 'walking' });
    const again = (await call(second.client, { stops, profile: 'walking' })) as { status: string };

    expect(again.status).toBe('found');
    expect(fake.requests).toHaveLength(1);
  });

  it('routes through several stops, with a leg for each pair', async () => {
    const { client } = await person('DRIVER', 'route-legs');
    const stops = [
      A,
      B,
      { latitude: 52.4862, longitude: -1.8904 },
      { latitude: 53.4808, longitude: -2.2426 },
    ];

    const result = (await call(client, { stops })) as { route: Route };

    expect(result.route.legs).toHaveLength(3);
    const total = result.route.legs.reduce((sum, leg) => sum + leg.distanceMeters, 0);
    expect(Math.abs(total - result.route.distanceMeters)).toBeLessThanOrEqual(3);
    expect(fake.requests[0]?.stops).toHaveLength(4);
  });

  it.each([
    [
      'OSRM has no route',
      { kind: 'status', status: 400, body: { code: 'NoRoute', message: 'x' } } as const,
    ],
    [
      'a stop is not near any road',
      {
        kind: 'route',
        body: defaultRouteBody({ stops: [A, B] }, { snapMeters: 594_326 }),
      } as const,
    ],
  ])('says "none" when %s, and remembers it', async (_label, reply) => {
    fake.reply(reply);
    const { client } = await person('PASSENGER', 'route-none');
    const stops = [
      { latitude: 60.1, longitude: 5.1 },
      { latitude: 60.2, longitude: 5.2 },
    ];

    expect(await call(client, { stops })).toEqual({ status: 'none', route: null });
    expect(await call(client, { stops })).toEqual({ status: 'none', route: null });
    expect(fake.requests).toHaveLength(1);
  });

  it.each([
    ['a 500', { kind: 'status', status: 500 } as const],
    ['a 429', { kind: 'status', status: 429 } as const],
    ['an answer that is not JSON', { kind: 'text', text: '<html>oops</html>' } as const],
    ['an answer in the wrong form', { kind: 'route', body: { code: 'Ok', routes: [] } } as const],
  ])(
    'says "unavailable" on %s, without an error, and does not remember it',
    async (_label, reply) => {
      fake.reply(reply);
      const { client } = await person('PASSENGER', 'route-fail');
      const stops = [
        { latitude: 61.1, longitude: 6.1 },
        { latitude: 61.2, longitude: 6.2 },
      ];

      expect(await call(client, { stops })).toEqual({ status: 'unavailable', route: null });

      fake.reply(null);
      expect(await call(client, { stops })).toMatchObject({ status: 'found' });
      expect(fake.requests).toHaveLength(2);
    },
  );

  it('gives up on a provider that never answers, instead of leaving the person waiting', async () => {
    fake.reply({ kind: 'hang' });
    const { client } = await person('PASSENGER', 'route-hang');

    const started = Date.now();
    const result = await call(client, {
      stops: [
        { latitude: 62.1, longitude: 7.1 },
        { latitude: 62.2, longitude: 7.2 },
      ],
    });

    expect(result).toEqual({ status: 'unavailable', route: null });
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 40_000);

  it('is refused for people who are not verified drivers or passengers', async () => {
    const unverified = await person('PASSENGER', 'route-unverified', false);
    await expect(call(unverified.client, { stops: [A, B] })).rejects.toMatchObject({
      code: 'functions/permission-denied',
    });
    await expect(call(createClient(), { stops: [A, B] })).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('is what the app calls for a walking route: on foot when asked, by road when not', async () => {
    const { client } = await person('DRIVER', 'route-app-walk');
    const stops = [
      { latitude: 51.5049, longitude: -0.0195 },
      { latitude: 51.507, longitude: -0.025 },
    ];

    const onFoot = await calculateRouteForApp(client, stops, { profile: 'walking' });
    const byRoad = await calculateRouteForApp(client, stops);

    expect(fake.requests.map((request) => request.profile)).toEqual(['walking', 'driving']);
    expect(
      (onFoot?.durationSeconds ?? 0) > (byRoad?.durationSeconds ?? Number.MAX_SAFE_INTEGER),
    ).toBe(true);
  });

  it('is what the app calls: the route back, and null (never an error) when it cannot be had', async () => {
    const { client } = await person('DRIVER', 'route-app');
    const outcomes: RouteOutcome[] = [];
    const stops = [
      { latitude: 63.1, longitude: 8.1 },
      { latitude: 63.2, longitude: 8.2 },
    ];

    const route = await calculateRouteForApp(client, stops, { onOutcome: (o) => outcomes.push(o) });
    expect(route?.distanceMeters).toBeGreaterThan(0);
    expect(route?.legs).toHaveLength(1);

    fake.reply({ kind: 'status', status: 500 });
    expect(
      await calculateRouteForApp(
        client,
        [
          { latitude: 63.3, longitude: 8.3 },
          { latitude: 63.4, longitude: 8.4 },
        ],
        { onOutcome: (o) => outcomes.push(o) },
      ),
    ).toBeNull();

    // Not even stops the server refuses (0, 0) or too few of them are an error for the caller.
    expect(
      await calculateRouteForApp(client, [{ latitude: 0, longitude: 0 }, stops[0] as RoutePoint], {
        onOutcome: (o) => outcomes.push(o),
      }),
    ).toBeNull();
    expect(
      await calculateRouteForApp(client, [stops[0] as RoutePoint], {
        onOutcome: (o) => outcomes.push(o),
      }),
    ).toBeNull();
    expect(outcomes).toEqual(['found', 'unavailable', 'failed', 'failed']);
  });
});
