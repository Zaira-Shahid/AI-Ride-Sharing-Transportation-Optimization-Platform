import { httpsCallable } from 'firebase/functions';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  reverseGeocode as reverseGeocodeAddress,
  type ReverseGeocodeOutcome,
} from '../../packages/firebase/src';
import {
  reverseGeocode,
  type GeocodePoint,
  type GeocodingLimits,
  type GeocodingProvider,
} from '../../functions/src/geocoding';
import { startFakeNominatim, type FakeNominatim } from '../fake-nominatim';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

// Two ways in. Most of the logic (the rounding, the cache, the limits, the failures) is tested by
// calling the function with a stand-in provider against the real Firestore emulator, which is quick
// and can control the clock. The rest goes through the real callable on the Functions emulator, which
// asks a fake Nominatim (tests/fake-nominatim.ts, found through functions/.env.demo-ridemesh), to
// prove the wiring: the environment, the request that leaves, and what comes back.

const rider = (uid = 'rider-1', role: string = 'PASSENGER', emailVerified = true) => ({
  uid,
  role,
  emailVerified,
});
const NO_LIMITS: GeocodingLimits = { globalSpacingMs: 0, perCallerPerMinute: 1_000 };

/** A different, distant position for every test, so the cache from one never answers another. */
let positionCounter = 0;
const newPosition = (): GeocodePoint => {
  positionCounter += 1;
  return { latitude: 10 + positionCounter * 0.01, longitude: 20 + positionCounter * 0.01 };
};

function stubProvider(answer: string | null | Error = '1 Stub Street, Testville') {
  const calls: GeocodePoint[] = [];
  const provider: GeocodingProvider = {
    reverse: (point) => {
      calls.push(point);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer);
    },
  };
  return { provider, calls };
}

const cacheDoc = async (key: string) =>
  (await admin().firestore.doc(`geocodeCache/${key}`).get()).data();
const limitsDoc = async (uid: string) =>
  (await admin().firestore.doc(`geocodeLimits/${uid}`).get()).data();

async function clearGeocodingState() {
  const { firestore } = admin();
  for (const name of ['geocodeCache', 'geocodeLimits', 'geocodeGlobal']) {
    await firestore.recursiveDelete(firestore.collection(name));
  }
}

let fake: FakeNominatim;
beforeAll(async () => {
  fake = await startFakeNominatim();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  await clearGeocodingState();
  fake.requests.length = 0;
  fake.reply(null);
});

describe('reverseGeocode: what the provider sees, and what is stored', () => {
  it('finds the address, asks the provider about the rounded position only, and caches it', async () => {
    const { provider, calls } = stubProvider('12 Test Street, Bristol, BS1 6QS');
    const exact = { latitude: 51.44941234, longitude: -2.58139876 };

    const result = await reverseGeocode(
      { firestore: admin().firestore, provider, limits: NO_LIMITS },
      rider(),
      exact,
    );

    expect(result).toEqual({ status: 'found', address: '12 Test Street, Bristol, BS1 6QS' });
    // The exact position never left: the provider was given the position rounded to 4 decimals.
    expect(calls).toEqual([{ latitude: 51.4494, longitude: -2.5814 }]);
    const stored = await cacheDoc('51.4494_-2.5814');
    expect(stored).toMatchObject({
      latitude: 51.4494,
      longitude: -2.5814,
      address: '12 Test Street, Bristol, BS1 6QS',
      source: 'nominatim',
    });
    expect(stored?.fetchedAt).toBeDefined();
    // Nothing about who asked, and nothing exact, is in the cache.
    expect(Object.keys(stored ?? {}).sort()).toEqual(
      ['address', 'fetchedAt', 'latitude', 'longitude', 'source'].sort(),
    );
    expect(JSON.stringify(stored)).not.toContain('rider-1');
    expect(JSON.stringify(stored)).not.toContain('51.44941234');
    expect(JSON.stringify(stored)).not.toContain('2.58139876');
  });

  it('answers from the cache, for anyone, without asking the provider or using up a limit', async () => {
    const { provider, calls } = stubProvider('1 Stub Street');
    const point = newPosition();
    const deps = { firestore: admin().firestore, provider, limits: NO_LIMITS };
    await reverseGeocode(deps, rider('first'), point);
    const before = await limitsDoc('second');

    const again = await reverseGeocode(deps, rider('second', 'DRIVER'), point);

    expect(again).toEqual({ status: 'found', address: '1 Stub Street' });
    expect(calls).toHaveLength(1);
    expect(before).toBeUndefined();
    expect(await limitsDoc('second')).toBeUndefined();
  });

  it('treats two positions that round to the same place as one', async () => {
    const { provider, calls } = stubProvider('1 Stub Street');
    const deps = { firestore: admin().firestore, provider, limits: NO_LIMITS };

    await reverseGeocode(deps, rider(), { latitude: 12.34561, longitude: 45.67891 });
    const second = await reverseGeocode(deps, rider(), { latitude: 12.34564, longitude: 45.67894 });

    expect(second.status).toBe('found');
    expect(calls).toHaveLength(1);
  });

  it('caches "no address here" too, so that spot is not asked about again', async () => {
    const { provider, calls } = stubProvider(null);
    const point = newPosition();
    const deps = { firestore: admin().firestore, provider, limits: NO_LIMITS };

    expect(await reverseGeocode(deps, rider(), point)).toEqual({ status: 'none', address: null });
    expect(await reverseGeocode(deps, rider(), point)).toEqual({ status: 'none', address: null });

    expect(calls).toHaveLength(1);
  });

  it('does not cache a failure, and the next try asks again', async () => {
    const failing = stubProvider(new Error('The provider answered 503.'));
    const point = newPosition();
    const firestore = admin().firestore;

    const first = await reverseGeocode(
      { firestore, provider: failing.provider, limits: NO_LIMITS },
      rider(),
      point,
    );
    expect(first).toEqual({ status: 'unavailable', address: null });
    expect(JSON.stringify(first)).not.toContain('503');

    const working = stubProvider('1 Stub Street');
    const second = await reverseGeocode(
      { firestore, provider: working.provider, limits: NO_LIMITS },
      rider(),
      point,
    );
    expect(second).toEqual({ status: 'found', address: '1 Stub Street' });
    expect(working.calls).toHaveLength(1);
  });
});

describe('reverseGeocode: the limits', () => {
  it('lets one caller cause only so many lookups in a minute, and others carry on', async () => {
    const { provider, calls } = stubProvider();
    const limits: GeocodingLimits = { globalSpacingMs: 0, perCallerPerMinute: 3 };
    const clock = { now: 1_000_000 };
    const deps = { firestore: admin().firestore, provider, limits, now: () => clock.now };

    for (let i = 0; i < 3; i += 1) {
      expect((await reverseGeocode(deps, rider('busy'), newPosition())).status).toBe('found');
    }
    const refused = await reverseGeocode(deps, rider('busy'), newPosition());
    expect(refused).toEqual({ status: 'busy', address: null });
    expect(calls).toHaveLength(3);

    // Somebody else is not affected, and the busy caller is fine again once the minute has passed.
    expect((await reverseGeocode(deps, rider('other'), newPosition())).status).toBe('found');
    clock.now += 61_000;
    expect((await reverseGeocode(deps, rider('busy'), newPosition())).status).toBe('found');
  });

  it('does not count lookups answered from the cache against the caller', async () => {
    const { provider } = stubProvider();
    const limits: GeocodingLimits = { globalSpacingMs: 0, perCallerPerMinute: 2 };
    const deps = { firestore: admin().firestore, provider, limits };
    const point = newPosition();
    await reverseGeocode(deps, rider('cached'), point);

    for (let i = 0; i < 6; i += 1) {
      expect((await reverseGeocode(deps, rider('cached'), point)).status).toBe('found');
    }
    expect(await limitsDoc('cached')).toMatchObject({ count: 1 });
  });

  it('keeps the provider to one request every 1.1 seconds for everybody together', async () => {
    const { provider, calls } = stubProvider();
    const limits: GeocodingLimits = { globalSpacingMs: 1_100, perCallerPerMinute: 100 };
    const clock = { now: 5_000_000 };
    const deps = { firestore: admin().firestore, provider, limits, now: () => clock.now };

    expect((await reverseGeocode(deps, rider('a'), newPosition())).status).toBe('found');
    clock.now += 500;
    expect(await reverseGeocode(deps, rider('b'), newPosition())).toEqual({
      status: 'busy',
      address: null,
    });
    clock.now += 599; // 1099 ms after the first
    expect((await reverseGeocode(deps, rider('b'), newPosition())).status).toBe('busy');
    clock.now += 1; // 1100 ms after the first
    expect((await reverseGeocode(deps, rider('b'), newPosition())).status).toBe('found');
    expect(calls).toHaveLength(2);
  });

  it('caches nothing and asks nobody when it is busy', async () => {
    const { provider, calls } = stubProvider();
    const limits: GeocodingLimits = { globalSpacingMs: 60_000, perCallerPerMinute: 100 };
    const deps = { firestore: admin().firestore, provider, limits, now: () => 9_000_000 };
    await reverseGeocode(deps, rider('a'), newPosition());
    const point = newPosition();

    expect((await reverseGeocode(deps, rider('b'), point)).status).toBe('busy');

    expect(calls).toHaveLength(1);
    expect(
      await cacheDoc(`${point.latitude.toFixed(4)}_${point.longitude.toFixed(4)}`),
    ).toBeUndefined();
  });

  it('stays correct when many lookups arrive at once: the provider is asked once per slot', async () => {
    const { provider, calls } = stubProvider();
    const limits: GeocodingLimits = { globalSpacingMs: 60_000, perCallerPerMinute: 100 };
    const deps = { firestore: admin().firestore, provider, limits, now: () => 7_000_000 };

    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        reverseGeocode(deps, rider(`c${i}`), newPosition()),
      ),
    );

    expect(results.filter((result) => result.status === 'found')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'busy')).toHaveLength(7);
    expect(calls).toHaveLength(1);
  });
});

describe('reverseGeocode: who may ask, and what', () => {
  it('is for verified drivers and passengers only', async () => {
    const { provider, calls } = stubProvider();
    const deps = { firestore: admin().firestore, provider, limits: NO_LIMITS };
    const point = newPosition();

    for (const caller of [
      rider('x', 'ADMIN'),
      rider('x', 'SUPER_ADMIN'),
      rider('x', 'SUPPORT'),
      rider('x', 'nonsense'),
      rider('x', ''),
      rider('x', 'PASSENGER', false),
      rider('x', 'DRIVER', false),
    ]) {
      await expect(reverseGeocode(deps, caller, point)).rejects.toMatchObject({
        code: 'permission-denied',
      });
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['0, 0', { latitude: 0, longitude: 0 }],
    ['a latitude out of range', { latitude: 91, longitude: 0 }],
    ['a longitude out of range', { latitude: 0, longitude: 181 }],
    ['text for a number', { latitude: '51', longitude: 0 }],
    ['a missing longitude', { latitude: 51 }],
    ['nothing', null],
  ])('refuses %s and asks nobody', async (_label, input) => {
    const { provider, calls } = stubProvider();

    await expect(
      reverseGeocode({ firestore: admin().firestore, provider, limits: NO_LIMITS }, rider(), input),
    ).rejects.toMatchObject({ code: 'invalid-argument' });

    expect(calls).toHaveLength(0);
  });
});

describe('the reverseGeocode callable (functions + firestore emulators, fake Nominatim)', () => {
  async function person(role: 'DRIVER' | 'PASSENGER', prefix: string, verified = true) {
    const client = createClient();
    const { user, uid, email } = await signUp(client, prefix);
    await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
    if (verified) await verifyEmail(user, email);
    else await user.getIdToken(true);
    return { client, uid };
  }
  const call = (client: Client, data: unknown) =>
    httpsCallable(client.functions, 'reverseGeocode')(data).then((result) => result.data);

  it('asks the provider named in the environment, as itself, about the rounded position', async () => {
    const { client } = await person('PASSENGER', 'geo-callable');
    const exact = { latitude: 51.44941234, longitude: -2.58139876 };

    const result = await call(client, exact);

    expect(result).toEqual({ status: 'found', address: '12 Test Street, Bristol, BS1 6QS' });
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request?.latitude).toBe(51.4494);
    expect(request?.longitude).toBe(-2.5814);
    expect(request?.headers['user-agent']).toBe('RideMesh-tests');
    expect(request?.search.get('accept-language')).toBe('en');
    // The exact position is nowhere in what was sent.
    expect(JSON.stringify(request?.search.toString())).not.toContain('44941234');
  });

  it('answers a second lookup of the same spot from the cache, for anybody', async () => {
    const first = await person('PASSENGER', 'geo-cache-1');
    const second = await person('DRIVER', 'geo-cache-2');
    const point = { latitude: 51.5, longitude: -0.1 };

    await call(first.client, point);
    const again = await call(second.client, { latitude: 51.50001, longitude: -0.10001 });

    expect(again).toMatchObject({ status: 'found' });
    expect(fake.requests).toHaveLength(1);
  });

  it('says "none" when the provider has no address, and remembers it', async () => {
    fake.reply({ kind: 'address', body: { error: 'Unable to geocode' } });
    const { client } = await person('PASSENGER', 'geo-none');
    const point = { latitude: 60.1, longitude: 5.1 };

    expect(await call(client, point)).toEqual({ status: 'none', address: null });
    expect(await call(client, point)).toEqual({ status: 'none', address: null });
    expect(fake.requests).toHaveLength(1);
  });

  it.each([
    ['a 500', { kind: 'status', status: 500 } as const],
    ['a 429', { kind: 'status', status: 429 } as const],
    ['an answer that is not JSON', { kind: 'text', text: '<html>oops</html>' } as const],
  ])(
    'says "unavailable" on %s, without an error, and does not remember it',
    async (_label, reply) => {
      fake.reply(reply);
      const { client } = await person('PASSENGER', 'geo-fail');
      const point = { latitude: 61.1, longitude: 6.1 };

      expect(await call(client, point)).toEqual({ status: 'unavailable', address: null });

      fake.reply(null);
      expect(await call(client, point)).toMatchObject({ status: 'found' });
      expect(fake.requests).toHaveLength(2);
    },
  );

  it('gives up on a provider that never answers, instead of leaving the person waiting', async () => {
    fake.reply({ kind: 'hang' });
    const { client } = await person('PASSENGER', 'geo-hang');

    const started = Date.now();
    const result = await call(client, { latitude: 62.1, longitude: 7.1 });

    expect(result).toEqual({ status: 'unavailable', address: null });
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('is refused for people who are not verified drivers or passengers', async () => {
    const unverified = await person('PASSENGER', 'geo-unverified', false);
    await expect(
      call(unverified.client, { latitude: 51.5, longitude: -0.1 }),
    ).rejects.toMatchObject({
      code: 'functions/permission-denied',
    });
    await expect(call(createClient(), { latitude: 51.5, longitude: -0.1 })).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('is what the app calls: an address back, and null (never an error) when it cannot be had', async () => {
    const { client } = await person('DRIVER', 'geo-app');
    const outcomes: (ReverseGeocodeOutcome | undefined)[] = [];

    expect(
      await reverseGeocodeAddress(
        client,
        { latitude: 63.1, longitude: 8.1 },
        { onOutcome: (o) => outcomes.push(o) },
      ),
    ).toBe('12 Test Street, Bristol, BS1 6QS');

    fake.reply({ kind: 'status', status: 500 });
    expect(
      await reverseGeocodeAddress(
        client,
        { latitude: 63.2, longitude: 8.2 },
        { onOutcome: (o) => outcomes.push(o) },
      ),
    ).toBeNull();

    // Not even a position the server refuses (0, 0) is an error for the caller.
    expect(
      await reverseGeocodeAddress(
        client,
        { latitude: 0, longitude: 0 },
        { onOutcome: (o) => outcomes.push(o) },
      ),
    ).toBeNull();
    expect(outcomes).toEqual(['found', 'unavailable', 'failed']);
  });
});
