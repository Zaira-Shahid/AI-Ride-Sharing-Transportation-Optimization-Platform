import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it } from 'vitest';
import { getOperationsSummary } from '../../packages/firebase/src';
import {
  OPS_COLLECTION,
  OPS_RETENTION_DAYS,
  OPS_SHARDS,
  ROUTE_BUSY,
  ROUTE_UNAVAILABLE,
  clearExpiredOpsCounters,
  dayOf,
  functionFailedKind,
  getOperationsSummaryForStaff,
  recordOpsEvent,
} from '../../functions/src/opsCounters';
import { calculateRoute, type Route, type RoutingProvider } from '../../functions/src/routing';
import { admin, createClient, signUp, verifyEmail } from './support';

// Phase 14 (Monitoring): the failure counters behind the Operations page, and the page's callable.
// The counters are tested by calling the functions directly with a fake clock; the callable through
// the real emulators, for who may read it.

const DAY_MS = 86_400_000;
// Noon UTC, so that "n days earlier" is always a different UTC day.
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const staffCaller = { uid: 'staff-1', role: 'ADMIN', emailVerified: true };

async function clear() {
  await admin().firestore.recursiveDelete(admin().firestore.collection(OPS_COLLECTION));
}
beforeEach(clear);

async function allCounts(): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const doc of (await admin().firestore.collection(OPS_COLLECTION).get()).docs) {
    for (const [kind, value] of Object.entries(doc.get('counts') as Record<string, number>)) {
      totals[kind] = (totals[kind] ?? 0) + value;
    }
  }
  return totals;
}

describe('recordOpsEvent', () => {
  it('counts each kind separately, adds up across the shards of a day, and keeps only a day and counts', async () => {
    const { firestore } = admin();
    for (let shard = 0; shard < OPS_SHARDS; shard += 1) {
      await recordOpsEvent(firestore, ROUTE_BUSY, { now: () => NOW, shard });
    }
    await recordOpsEvent(firestore, ROUTE_BUSY, { now: () => NOW, shard: 0 });
    await recordOpsEvent(firestore, ROUTE_UNAVAILABLE, { now: () => NOW, shard: 3 });

    expect(await allCounts()).toEqual({ [ROUTE_BUSY]: OPS_SHARDS + 1, [ROUTE_UNAVAILABLE]: 1 });
    const docs = (await firestore.collection(OPS_COLLECTION).get()).docs;
    expect(docs).toHaveLength(OPS_SHARDS);
    // Privacy: a day and counts by kind. No uid, no trip, no place, nothing else.
    for (const doc of docs) {
      expect(Object.keys(doc.data()).sort()).toEqual(['counts', 'day']);
      expect(doc.get('day')).toBe('2026-10-03');
    }
  });

  it('never throws, and never fails what it counts, even when the write cannot be made', async () => {
    const broken = {
      collection: () => {
        throw new Error('Firestore is down');
      },
    } as unknown as FirebaseFirestore.Firestore;
    await expect(recordOpsEvent(broken, ROUTE_BUSY)).resolves.toBeUndefined();

    const failingWrite = {
      collection: () => ({
        doc: () => ({ set: () => Promise.reject(new Error('lock timeout')) }),
      }),
    } as unknown as FirebaseFirestore.Firestore;
    await expect(recordOpsEvent(failingWrite, ROUTE_BUSY)).resolves.toBeUndefined();
  });
});

describe('getOperationsSummaryForStaff', () => {
  async function put(daysAgo: number, shard: number, counts: Record<string, number>) {
    const day = dayOf(NOW - daysAgo * DAY_MS);
    await admin().firestore.collection(OPS_COLLECTION).doc(`${day}_${shard}`).set({ day, counts });
  }
  const summary = () =>
    getOperationsSummaryForStaff({ firestore: admin().firestore, now: () => NOW }, staffCaller);

  it('adds up today, the last seven days and each day, split by what failed', async () => {
    await put(0, 0, { [ROUTE_BUSY]: 5, [ROUTE_UNAVAILABLE]: 1, [functionFailedKind('a')]: 2 });
    await put(0, 4, { [ROUTE_BUSY]: 3, [functionFailedKind('b')]: 1 });
    await put(2, 1, { [ROUTE_UNAVAILABLE]: 4, [functionFailedKind('a')]: 3 });
    await put(6, 0, { [ROUTE_BUSY]: 10 });
    // Outside the seven days: not counted anywhere.
    await put(7, 0, { [ROUTE_BUSY]: 1000, [functionFailedKind('a')]: 1000 });
    await put(20, 0, { [ROUTE_UNAVAILABLE]: 1000 });

    const result = await summary();

    expect(result.today).toEqual({
      fromDay: '2026-10-03',
      toDay: '2026-10-03',
      routeBusy: 8,
      routeUnavailable: 1,
      functionFailures: { a: 2, b: 1 },
    });
    expect(result.last7Days).toEqual({
      fromDay: '2026-09-27',
      toDay: '2026-10-03',
      routeBusy: 18,
      routeUnavailable: 5,
      functionFailures: { a: 5, b: 1 },
    });
    expect(result.days).toHaveLength(7);
    expect(result.days.map((d) => d.day)).toEqual([
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
    expect(result.days[0]).toEqual({
      day: '2026-09-27',
      routeBusy: 10,
      routeUnavailable: 0,
      functionFailures: 0,
    });
    expect(result.days[4]).toEqual({
      day: '2026-10-01',
      routeBusy: 0,
      routeUnavailable: 4,
      functionFailures: 3,
    });
    expect(result.retentionDays).toBe(OPS_RETENTION_DAYS);
  });

  it('is empty, not an error, when nothing has been counted', async () => {
    const result = await summary();
    expect(result.today.routeBusy).toBe(0);
    expect(result.last7Days.functionFailures).toEqual({});
    expect(
      result.days.every((d) => d.routeBusy + d.routeUnavailable + d.functionFailures === 0),
    ).toBe(true);
  });

  it('ignores a kind it does not know and a count that is not a number', async () => {
    await put(0, 0, { 'something-else': 9, [ROUTE_BUSY]: Number.NaN, [ROUTE_UNAVAILABLE]: 2 });
    const result = await summary();
    expect(result.today.routeUnavailable).toBe(2);
    expect(result.today.routeBusy).toBe(0);
    expect(result.today.functionFailures).toEqual({});
  });

  it('refuses anyone who is not a verified staff member', async () => {
    const deps = { firestore: admin().firestore, now: () => NOW };
    for (const caller of [
      { uid: 'p', role: 'PASSENGER', emailVerified: true },
      { uid: 'd', role: 'DRIVER', emailVerified: true },
      { uid: 's', role: 'ADMIN', emailVerified: false },
    ]) {
      await expect(getOperationsSummaryForStaff(deps, caller)).rejects.toMatchObject({
        code: 'permission-denied',
      });
    }
  });
});

describe('clearExpiredOpsCounters', () => {
  it('deletes counter days older than the retention and keeps the rest', async () => {
    const { firestore } = admin();
    const put = (daysAgo: number, shard: number) => {
      const day = dayOf(NOW - daysAgo * DAY_MS);
      return firestore
        .collection(OPS_COLLECTION)
        .doc(`${day}_${shard}`)
        .set({ day, counts: { [ROUTE_BUSY]: 1 } });
    };
    await Promise.all([
      put(0, 0),
      put(OPS_RETENTION_DAYS - 1, 0),
      put(OPS_RETENTION_DAYS + 1, 0),
      put(OPS_RETENTION_DAYS + 1, 1),
      put(OPS_RETENTION_DAYS + 40, 2),
    ]);

    const outcome = await clearExpiredOpsCounters({ firestore, now: () => NOW });

    expect(outcome).toEqual({ checked: 3, cleared: 3 });
    const left = (await firestore.collection(OPS_COLLECTION).get()).docs.map((d) => d.get('day'));
    expect(left.sort()).toEqual(
      [dayOf(NOW - (OPS_RETENTION_DAYS - 1) * DAY_MS), dayOf(NOW)].sort(),
    );
  });
});

describe('route lookups are counted where they fail (calculateRoute)', () => {
  const ROUTE: Route = {
    distanceMeters: 1000,
    durationSeconds: 100,
    geometry: 'x',
    legs: [{ distanceMeters: 1000, durationSeconds: 100 }],
  };
  const collections = {
    cache: 'opsCountersTestRouteCache',
    limits: { perCaller: 'opsCountersTestRouteLimits', global: 'opsCountersTestRouteGlobal' },
  };
  const caller = { uid: 'ops-rider', role: 'PASSENGER', emailVerified: true };
  const limits = { globalSpacingMs: 1_100, perCallerPerMinute: 100 };
  let stops = 0;
  const newStops = () => {
    stops += 1;
    return [
      { latitude: 20 + stops * 0.1, longitude: 30 },
      { latitude: 20.05 + stops * 0.1, longitude: 30.05 },
    ];
  };
  const run = (provider: RoutingProvider, now: number) =>
    calculateRoute(
      { firestore: admin().firestore, provider, limits, collections, now: () => now },
      caller,
      { stops: newStops() },
    );

  beforeEach(async () => {
    for (const name of [
      collections.cache,
      collections.limits.perCaller,
      collections.limits.global,
    ]) {
      await admin().firestore.recursiveDelete(admin().firestore.collection(name));
    }
  });

  it('counts a provider failure as unavailable and a refused lookup as busy', async () => {
    const failing: RoutingProvider = { route: () => Promise.reject(new Error('down')) };
    const working: RoutingProvider = { route: () => Promise.resolve(ROUTE) };

    expect((await run(failing, 1_000_000)).status).toBe('unavailable');
    // Same moment: the provider was just used, so this one is refused.
    expect((await run(working, 1_000_000)).status).toBe('busy');
    expect((await run(working, 1_000_000)).status).toBe('busy');

    expect(await allCounts()).toEqual({ [ROUTE_UNAVAILABLE]: 1, [ROUTE_BUSY]: 2 });
  });

  it('does not count a found route, a "no route here", or an answer from the cache', async () => {
    const found: RoutingProvider = { route: () => Promise.resolve(ROUTE) };
    const none: RoutingProvider = { route: () => Promise.resolve(null) };

    expect((await run(found, 2_000_000)).status).toBe('found');
    expect((await run(none, 2_000_000 + 5_000)).status).toBe('none');
    // The same stops again come from the cache: no lookup, nothing to count.
    const again = {
      stops: [
        { latitude: 20.1, longitude: 30 },
        { latitude: 20.15, longitude: 30.05 },
      ],
    };
    await calculateRoute(
      {
        firestore: admin().firestore,
        provider: found,
        limits,
        collections,
        now: () => 2_000_000 + 10_000,
      },
      caller,
      again,
    );
    await calculateRoute(
      {
        firestore: admin().firestore,
        provider: { route: () => Promise.reject(new Error('must not be asked')) },
        limits,
        collections,
        now: () => 2_000_000 + 10_000,
      },
      caller,
      again,
    );

    expect(await allCounts()).toEqual({});
  });
});

describe('every caught exception of a trigger or sweep is counted (functions/src/index.ts)', () => {
  // The catch blocks cannot be reached with a real exception on the emulators (every one is a "never
  // throws" wrapper around code that handles its own failures), so this checks the source: each
  // logger.warn/error of a failure in index.ts is immediately preceded by a recordFailure call.
  const source = readFileSync(
    join(resolve(__dirname, '..', '..'), 'functions/src/index.ts'),
    'utf8',
  ).split(/\r?\n/);

  it('puts recordFailure right before every failure log', () => {
    const failureLogs = source
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /logger\.(warn|error)\(/.test(line))
      // Not a failure: the optimization service simply is not configured.
      .filter(({ line }) => !line.includes('OPTIMIZATION_SERVICE_URL is not set'));
    expect(failureLogs.length).toBeGreaterThanOrEqual(11);
    for (const { line, i } of failureLogs) {
      expect(source[i - 1], `before: ${line.trim()}`).toMatch(/await recordFailure\(/);
    }
  });
});

describe('getOperationsSummary (functions + firestore + auth emulators)', () => {
  async function user(prefix: string, role: string) {
    const client = createClient();
    const { user: signedIn, uid, email } = await signUp(client, prefix);
    await admin().auth.setCustomUserClaims(uid, { role });
    await verifyEmail(signedIn, email);
    return client;
  }

  it('lets any staff role read it, and refuses a passenger, a driver and a stranger', async () => {
    for (const role of ['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN']) {
      const client = await user(`ops-${role.toLowerCase()}`, role);
      await expect(getOperationsSummary(client)).resolves.toMatchObject({
        retentionDays: OPS_RETENTION_DAYS,
      });
    }
    for (const role of ['PASSENGER', 'DRIVER']) {
      const client = await user(`ops-no-${role.toLowerCase()}`, role);
      await expect(getOperationsSummary(client)).rejects.toMatchObject({
        message: 'You are not allowed to view operations.',
      });
    }
    await expect(
      httpsCallable(createClient().functions, 'getOperationsSummary')(),
    ).rejects.toMatchObject({ code: 'functions/unauthenticated' });
  });

  it('shows what has been counted, through the real callable', async () => {
    await recordOpsEvent(admin().firestore, ROUTE_UNAVAILABLE);
    await recordOpsEvent(admin().firestore, functionFailedKind('batchOptimizationRun'));
    const client = await user('ops-reads-counts', 'ADMIN');

    const result = await getOperationsSummary(client);

    expect(result.today.routeUnavailable).toBe(1);
    expect(result.today.functionFailures).toEqual({ batchOptimizationRun: 1 });
  });
});
