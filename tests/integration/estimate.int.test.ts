import { httpsCallable } from 'firebase/functions';
import type { DocumentReference } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cancelTripRequest, createTripRequest } from '../../packages/firebase/src';
import {
  ESTIMATE_BUSY_ATTEMPTS,
  ESTIMATE_BUSY_WAIT_MS,
  estimateTripRequest,
} from '../../functions/src/estimates';
import type { LookupLimits } from '../../functions/src/lookupLimits';
import type { Route, RoutePoint, RoutingProvider } from '../../functions/src/routing';
import { defaultRouteBody, startFakeOsrm, type FakeOsrm } from '../fake-osrm';
import { admin, createClient, signUp, verifyEmail } from './support';

// The estimate of a trip request (Modules 4.4 and 4.5). Two ways in, as for routes. The logic (what
// is written, what is left alone, the retries, the races) is tested by calling estimateTripRequest
// with a stand-in provider on requests made by hand in another collection, so that the trigger does
// not also work on them. The trigger itself is tested end to end: a request made through the real
// function gets its estimate from a fake OSRM a moment later.

const NO_LIMITS: LookupLimits = { globalSpacingMs: 0, perCallerPerMinute: 1_000 };
const ROUTE: Route = {
  distanceMeters: 8_234,
  durationSeconds: 1_080,
  geometry: '_p~iF~ps|U',
  legs: [{ distanceMeters: 8_234, durationSeconds: 1_080 }],
};

let counter = 0;
const uid = () => {
  counter += 1;
  return `estimate-passenger-${counter}`;
};

/** A different pair of places for every test, so the route cache from one never answers another. */
const places = () => {
  counter += 1;
  return {
    origin: {
      latitude: 30 + counter * 0.1,
      longitude: 40 + counter * 0.1,
      formattedAddress: 'A',
      placeId: null,
    },
    destination: {
      latitude: 30.05 + counter * 0.1,
      longitude: 40.05 + counter * 0.1,
      formattedAddress: 'B',
      placeId: null,
    },
  };
};

const TEST_COLLECTION = 'tripRequestsUnderTest';

async function makeTrip(fields: Record<string, unknown> = {}) {
  const passengerId = uid();
  const ref = admin().firestore.collection(TEST_COLLECTION).doc();
  const data: Record<string, unknown> = {
    passengerId,
    ...places(),
    status: 'REQUESTED',
    estimatedFare: null,
    estimatedDistance: null,
    estimatedDuration: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  };
  // A field given as undefined means the request does not have it at all.
  for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key];
  await ref.set(data);
  return { id: ref.id, ref, passengerId };
}
const tripData = async (ref: DocumentReference) => (await ref.get()).data();
const without = (data: Record<string, unknown> | undefined, keys: string[]) =>
  Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => !keys.includes(key)));

function stubProvider(answer: Route | null | Error | (() => Promise<Route | null>) = ROUTE) {
  const calls: RoutePoint[][] = [];
  const provider: RoutingProvider = {
    route: (stops) => {
      calls.push(stops);
      if (typeof answer === 'function') return answer();
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer);
    },
  };
  return { provider, calls };
}
const deps = (provider: RoutingProvider, extra: Record<string, unknown> = {}) => ({
  firestore: admin().firestore,
  provider,
  limits: NO_LIMITS,
  collection: TEST_COLLECTION,
  ...extra,
});

async function clearState() {
  const { firestore } = admin();
  for (const name of [TEST_COLLECTION, 'routeCache', 'routeLimits', 'routeGlobal']) {
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
  await clearState();
  fake.requests.length = 0;
  fake.reply(null);
});

describe('estimateTripRequest: what is written', () => {
  it('writes the distance in metres and the time in seconds, and nothing else but the time of change', async () => {
    const { provider, calls } = stubProvider();
    const { ref, id } = await makeTrip();
    const before = await tripData(ref);

    expect(await estimateTripRequest(deps(provider), id)).toBe('estimated');

    const after = await tripData(ref);
    expect(after?.estimatedDistance).toBe(8_234);
    expect(after?.estimatedDuration).toBe(1_080);
    expect(Number.isInteger(after?.estimatedDistance)).toBe(true);
    expect(Number.isInteger(after?.estimatedDuration)).toBe(true);
    // Everything else about the request is as it was: the estimate, and the time it changed, is all
    // this touches.
    const changed = ['estimatedDistance', 'estimatedDuration', 'updatedAt'];
    expect(without(after, changed)).toEqual(without(before, changed));
    expect(after?.updatedAt).toBeDefined();
    expect(after?.estimatedFare).toBeNull();
    expect(after?.status).toBe('REQUESTED');
    expect(calls).toHaveLength(1);
  });

  it('asks for the route from the pickup to the destination, both rounded to about 11 m', async () => {
    const { provider, calls } = stubProvider();
    const { id } = await makeTrip({
      origin: {
        latitude: 51.44941234,
        longitude: -2.58139876,
        formattedAddress: 'A',
        placeId: null,
      },
      destination: {
        latitude: 51.50494321,
        longitude: -0.01949999,
        formattedAddress: 'B',
        placeId: 'p',
      },
    });

    await estimateTripRequest(deps(provider), id);

    expect(calls).toEqual([
      [
        { latitude: 51.4494, longitude: -2.5814 },
        { latitude: 51.5049, longitude: -0.0195 },
      ],
    ]);
  });

  it.each(['REQUESTED', 'SEARCHING', 'MATCHED', 'PICKUP_ASSIGNED', 'IN_TRANSIT'])(
    'estimates a request that is %s',
    async (status) => {
      const { provider } = stubProvider();
      const { ref, id } = await makeTrip({ status });

      expect(await estimateTripRequest(deps(provider), id)).toBe('estimated');
      expect((await tripData(ref))?.estimatedDistance).toBe(8_234);
    },
  );
});

describe('estimateTripRequest: what is left alone', () => {
  it.each(['CANCELLED', 'COMPLETED'])('a request that is %s', async (status) => {
    const { provider, calls } = stubProvider();
    const { ref, id } = await makeTrip({ status });

    expect(await estimateTripRequest(deps(provider), id)).toBe('skipped');

    expect(calls).toHaveLength(0);
    expect((await tripData(ref))?.estimatedDistance).toBeNull();
  });

  it('a request that does not exist', async () => {
    const { provider, calls } = stubProvider();
    expect(await estimateTripRequest(deps(provider), 'nothing-here')).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('a request that already has an estimate, even half of one', async () => {
    const { provider, calls } = stubProvider();
    const done = await makeTrip({ estimatedDistance: 1, estimatedDuration: 2 });
    const half = await makeTrip({ estimatedDistance: 7 });

    expect(await estimateTripRequest(deps(provider), done.id)).toBe('skipped');
    expect(await estimateTripRequest(deps(provider), half.id)).toBe('skipped');

    expect(calls).toHaveLength(0);
    expect((await tripData(done.ref))?.estimatedDistance).toBe(1);
    expect((await tripData(half.ref))?.estimatedDuration).toBeNull();
  });

  it.each([
    ['no passenger', { passengerId: undefined }],
    ['a passenger that is not text', { passengerId: 5 }],
    ['no pickup', { origin: null }],
    ['a destination without a position', { destination: { formattedAddress: 'B' } }],
    ['a position that is not numbers', { origin: { latitude: '51', longitude: 0 } }],
  ])('a request with %s', async (_label, fields) => {
    const { provider, calls } = stubProvider();
    const { ref, id } = await makeTrip(fields);

    expect(await estimateTripRequest(deps(provider), id)).toBe('skipped');

    expect(calls).toHaveLength(0);
    expect((await tripData(ref))?.estimatedDistance).toBeNull();
  });

  it('a request with places the routing rules refuse (0, 0), without an error', async () => {
    const { provider, calls } = stubProvider();
    const { ref, id } = await makeTrip({
      origin: { latitude: 0, longitude: 0, formattedAddress: 'nowhere', placeId: null },
    });

    expect(await estimateTripRequest(deps(provider), id)).toBe('unavailable');

    expect(calls).toHaveLength(0);
    expect((await tripData(ref))?.estimatedDistance).toBeNull();
  });

  it('a request cancelled while its route was being found', async () => {
    const { ref, id } = await makeTrip();
    const { provider } = stubProvider(async () => {
      await ref.update({ status: 'CANCELLED' });
      return ROUTE;
    });

    expect(await estimateTripRequest(deps(provider), id)).toBe('skipped');

    const after = await tripData(ref);
    expect(after?.status).toBe('CANCELLED');
    expect(after?.estimatedDistance).toBeNull();
  });
});

describe('estimateTripRequest: when the route cannot be had', () => {
  it.each([
    ['the routing server fails', new Error('The provider answered 503.')],
    ['there is no road route', null],
  ])('writes nothing when %s, and does not throw', async (_label, answer) => {
    const { provider } = stubProvider(answer);
    const { ref, id } = await makeTrip();

    expect(await estimateTripRequest(deps(provider), id)).toBe('unavailable');

    const after = await tripData(ref);
    expect(after?.estimatedDistance).toBeNull();
    expect(after?.estimatedDuration).toBeNull();
    expect(after?.status).toBe('REQUESTED');
  });

  it('waits and tries again when the server is busy, and then writes the estimate', async () => {
    const { provider, calls } = stubProvider();
    const { ref, id } = await makeTrip();
    const clock = { now: 8_000_000 };
    const sleeps: number[] = [];
    // A route was asked for a moment ago, so the next one has to wait its turn.
    await admin().firestore.doc('routeGlobal/lookups').set({ lastAt: clock.now });

    const outcome = await estimateTripRequest(
      deps(provider, {
        limits: { globalSpacingMs: 1_100, perCallerPerMinute: 100 },
        now: () => clock.now,
        sleep: (ms: number) => {
          sleeps.push(ms);
          clock.now += ms;
          return Promise.resolve();
        },
      }),
      id,
    );

    expect(outcome).toBe('estimated');
    expect(sleeps).toEqual([ESTIMATE_BUSY_WAIT_MS]);
    expect(ESTIMATE_BUSY_WAIT_MS).toBeGreaterThan(1_100);
    expect(calls).toHaveLength(1);
    expect((await tripData(ref))?.estimatedDistance).toBe(8_234);
  });

  it('gives up after a few tries when the server stays busy, and writes nothing', async () => {
    const { provider, calls } = stubProvider();
    const { ref, id } = await makeTrip();
    const sleeps: number[] = [];
    await admin().firestore.doc('routeGlobal/lookups').set({ lastAt: 8_000_000 });

    const outcome = await estimateTripRequest(
      deps(provider, {
        limits: { globalSpacingMs: 3_600_000, perCallerPerMinute: 100 },
        now: () => 8_000_000,
        sleep: (ms: number) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      }),
      id,
    );

    expect(outcome).toBe('unavailable');
    expect(sleeps).toHaveLength(ESTIMATE_BUSY_ATTEMPTS - 1);
    expect(calls).toHaveLength(0);
    expect((await tripData(ref))?.estimatedDistance).toBeNull();
  });

  it('does not wait for a failed or missing route: only "busy" is worth waiting for', async () => {
    const { provider } = stubProvider(new Error('down'));
    const { id } = await makeTrip();
    const sleeps: number[] = [];

    await estimateTripRequest(
      deps(provider, {
        sleep: (ms: number) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      }),
      id,
    );

    expect(sleeps).toEqual([]);
  });
});

describe('estimateTripRequest: limits, the cache and repeats', () => {
  it('counts against the passenger, like any route they cause, and uses the route cache', async () => {
    const { provider, calls } = stubProvider();
    const shared = places();
    const first = await makeTrip(shared);
    const second = await makeTrip({ ...shared, passengerId: first.passengerId });

    await estimateTripRequest(deps(provider), first.id);
    await estimateTripRequest(deps(provider), second.id);

    // The second request between the same places is answered from the cache: one route asked for,
    // one counted against the passenger.
    expect(calls).toHaveLength(1);
    const limits = (await admin().firestore.doc(`routeLimits/${first.passengerId}`).get()).data();
    expect(limits?.count).toBe(1);
    expect((await tripData(second.ref))?.estimatedDistance).toBe(8_234);
  });

  it('is safe to run twice at once: the estimate is written once', async () => {
    const { provider } = stubProvider();
    const { ref, id } = await makeTrip();

    const outcomes = await Promise.all([
      estimateTripRequest(deps(provider), id),
      estimateTripRequest(deps(provider), id),
    ]);

    expect(outcomes.filter((outcome) => outcome === 'estimated')).toHaveLength(1);
    expect((await tripData(ref))?.estimatedDistance).toBe(8_234);
  });

  it('does not overwrite an estimate that arrived while its route was being found', async () => {
    const { ref, id } = await makeTrip();
    const { provider } = stubProvider(async () => {
      await ref.update({ estimatedDistance: 111, estimatedDuration: 222 });
      return ROUTE;
    });

    expect(await estimateTripRequest(deps(provider), id)).toBe('skipped');

    expect((await tripData(ref))?.estimatedDistance).toBe(111);
  });
});

describe('the trigger: a new trip request gets its estimate (functions + firestore emulators, fake OSRM)', () => {
  async function passenger(prefix: string) {
    const client = createClient();
    const { user, uid: id, email } = await signUp(client, prefix);
    await httpsCallable(
      client.functions,
      'completeRegistration',
    )({
      role: 'PASSENGER',
      name: 'Test Person',
    });
    await verifyEmail(user, email);
    return { client, uid: id };
  }
  const BALANCED = {
    flexibilityLevel: 'BALANCED' as const,
    maxWalkingDistance: 500,
    maxExtraTime: 10,
    maxDetourDistance: 3,
    allowSharedRide: true,
    allowRouteChange: true,
  };
  const request = (origin: RoutePoint, destination: RoutePoint) => ({
    origin: { ...origin, formattedAddress: 'Pickup', placeId: null },
    destination: { ...destination, formattedAddress: 'Destination', placeId: null },
    departure: { kind: 'NOW' as const },
    arriveBy: null,
    preferences: BALANCED,
  });
  const tripsOf = async (passengerId: string) =>
    (
      await admin()
        .firestore.collection('tripRequests')
        .where('passengerId', '==', passengerId)
        .get()
    ).docs;
  async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
    const stop = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() > stop) throw new Error('Timed out waiting.');
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  const estimateOf = (id: string) => async () => {
    const data = (await admin().firestore.doc(`tripRequests/${id}`).get()).data();
    return data?.estimatedDistance == null ? undefined : data;
  };

  const A = { latitude: 51.44941234, longitude: -2.58139876 };
  const B = { latitude: 51.50494321, longitude: -0.01949999 };

  it('fills in the distance and time a moment after the request is created', async () => {
    const { client } = await passenger('est-trigger');

    const tripId = await createTripRequest(client, request(A, B));

    const trip = await waitFor(estimateOf(tripId));
    // What the route function found for the rounded places: metres and whole seconds.
    const rounded = [
      { latitude: 51.4494, longitude: -2.5814 },
      { latitude: 51.5049, longitude: -0.0195 },
    ];
    const expected = defaultRouteBody({ stops: rounded }).routes[0];
    expect(trip.estimatedDistance).toBe(Math.round(expected?.distance ?? Number.NaN));
    expect(trip.estimatedDuration).toBe(Math.round(expected?.duration ?? Number.NaN));
    expect(Number.isInteger(trip.estimatedDistance)).toBe(true);
    expect(trip.estimatedDistance).toBeGreaterThan(150_000);
    // The search-starting trigger (Modules 5.2 and 5.3) runs independently of this one and usually
    // finishes first (it never waits on a routing server), so this leave-now request is normally
    // already SEARCHING by now.
    expect(['REQUESTED', 'SEARCHING']).toContain(trip.status);
    // One lookup, for the rounded places, asked as the routing server's contact says. Other leave-now
    // requests elsewhere in the suite may leave an AVAILABLE journey that happens to be a candidate
    // for this one too (Modules 5.2-5.5 start searching automatically), asking for other routes of
    // their own - so only the exact A -> B lookup is counted, not every request the fake server saw.
    const forThisTrip = fake.requests.filter(
      (req) => JSON.stringify(req.stops) === JSON.stringify(rounded),
    );
    expect(forThisTrip).toHaveLength(1);
    expect(forThisTrip[0]?.headers['user-agent']).toBe('RideMesh-tests');
  });

  it('asks the routing server once for the same places, whoever asks', async () => {
    const rounded = [
      { latitude: 51.4494, longitude: -2.5814 },
      { latitude: 51.5049, longitude: -0.0195 },
    ];
    const first = await passenger('est-cache-1');
    const second = await passenger('est-cache-2');

    const one = await createTripRequest(first.client, request(A, B));
    await waitFor(estimateOf(one));
    const two = await createTripRequest(second.client, request(A, B));
    const trip = await waitFor(estimateOf(two));

    expect(trip.estimatedDistance).toBeGreaterThan(0);
    // Only the exact A -> B lookup is counted; see the note above the previous test.
    const forThisTrip = fake.requests.filter(
      (req) => JSON.stringify(req.stops) === JSON.stringify(rounded),
    );
    expect(forThisTrip).toHaveLength(1);
  });

  it('never fails or delays creating the request when the routing server is down', async () => {
    fake.reply({ kind: 'status', status: 500 });
    const { client, uid: passengerId } = await passenger('est-down');

    const started = Date.now();
    const tripId = await createTripRequest(client, request(A, { latitude: 52.1, longitude: -1.5 }));

    expect(Date.now() - started).toBeLessThan(15_000);
    // The request stands, and its estimate stays empty (the app says it is not available).
    await waitFor(async () => (fake.requests.length > 0 ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    // The search-starting trigger (Modules 5.2 and 5.3) does not depend on the routing server, so
    // this leave-now request is normally already SEARCHING by now.
    expect(['REQUESTED', 'SEARCHING']).toContain(trip?.status);
    expect(trip?.estimatedDistance).toBeNull();
    expect(trip?.estimatedDuration).toBeNull();
    expect((await tripsOf(passengerId)).length).toBe(1);
  }, 40_000);

  it('does not estimate a request that was cancelled while its route was being found', async () => {
    // The route is held until the test says so, so the cancellation is decided to come first (a
    // fixed delay would make the test a race between it and how fast the cancel call happens to run).
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.reply((requestSeen) => ({
      kind: 'wait',
      until: held,
      then: { kind: 'route', body: defaultRouteBody(requestSeen) },
    }));
    const { client } = await passenger('est-cancel');

    const tripId = await createTripRequest(client, request(A, { latitude: 52.2, longitude: -1.4 }));
    // The trigger has asked for the route, and is waiting for the answer.
    await waitFor(async () => (fake.requests.length > 0 ? true : undefined));
    expect(await cancelTripRequest(client, tripId)).toBe('cancelled');

    // Only now does the route come back. Give the trigger time to act on it, if it were going to.
    release();
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('CANCELLED');
    expect(trip?.estimatedDistance).toBeNull();
    expect(trip?.estimatedDuration).toBeNull();
  }, 40_000);
});
