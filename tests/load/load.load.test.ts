import { httpsCallable } from 'firebase/functions';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { runBatchOptimization } from '../../functions/src/optimizationRun';
import type { PushProvider } from '../../functions/src/pushProvider';
import { ROUTE_LIMITS, type RoutePoint, type RoutingProvider } from '../../functions/src/routing';
import { distanceMeters } from '../../functions/src/tripRequests';
import { defaultRouteBody, startFakeOsrm } from '../fake-osrm';
import { startOptimizationService } from '../optimization-service';
import { admin, createClient, signUp, verifyEmail } from '../integration/support';
import { sectionRecorder } from './record';

// Phase 14 (Load testing). Not part of CI and not a capacity figure: it runs against the emulators
// (`npm run load`), on a developer's machine, under a project of its own (demo-ridemesh-load) whose
// Functions environment keeps the REAL route limits (functions/.env.demo-ridemesh-load: the tests'
// usual environment turns the spacing off). It writes what it measured to tests/load/last-run.json
// (git-ignored; vitest does not show a test's console output under the emulators) for
// docs/load-testing.md, and asserts only that what it ran completed.
//
// Two questions, both about the route lookups, which every request and every match needs and which
// ROUTE_LIMITS lets through at one every 1.1 seconds for the whole system together:
//   A. a burst of trip requests, through the emulator's triggers: how long does creating one take, and
//      how long until each has its estimate? CAUTION: the emulator runs a background trigger one
//      invocation at a time (its log shows at most 1 estimateTripRequestOnCreate running at once),
//      which production does not, so this shows a single instance working through a queue, NOT what a
//      concurrent burst does to the route counter. estimateBurst.load.test.ts measures that.
//   B. a batch optimization run: how many route lookups does a network of a given size need?

const { reset, record } = sectionRecorder('emulator-triggers-and-network-size');
beforeAll(reset);

const rounded = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const percentile = (values: number[], p: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
};

/** A repeatable pseudo-random sequence (mulberry32), so a run can be repeated exactly. */
function randomSequence(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// A. A burst of trip requests
// ---------------------------------------------------------------------------------------------

// What a real routing server takes to answer, added to every route the fake one gives. An assumption,
// not a measurement of any server.
const ROUTE_LATENCY_MS = 150;
const PREFERENCES = {
  flexibilityLevel: 'BALANCED',
  maxWalkingDistance: 500,
  maxExtraTime: 10,
  maxDetourDistance: 3,
  allowSharedRide: true,
  allowRouteChange: true,
};

describe('A. a burst of trip requests, under the real route limits', () => {
  const place = (latitude: number, longitude: number, label: string) => ({
    latitude,
    longitude,
    formattedAddress: label,
    placeId: label,
  });

  /** `burst` passengers, each with a request of their own (distinct places, so nothing is cached). */
  async function runBurst(burst: number, offset: number) {
    const clients: ReturnType<typeof createClient>[] = [];
    for (let batch = 0; batch < burst; batch += 10) {
      const part = await Promise.all(
        Array.from({ length: Math.min(10, burst - batch) }, async (_, i) => {
          const client = createClient();
          const { user, email } = await signUp(client, `load-a-${offset}-${batch + i}`);
          await httpsCallable(
            client.functions,
            'completeRegistration',
          )({
            role: 'PASSENGER',
            name: 'Load Person',
          });
          await verifyEmail(user, email);
          return client;
        }),
      );
      clients.push(...part);
    }

    const requestFor = (index: number) => {
      const north = 51.2 + offset * 0.2 + (index % 10) * 0.012;
      const east = -0.4 + Math.floor(index / 10) * 0.012;
      return {
        origin: place(north, east, `Origin ${offset}-${index}`),
        destination: place(north + 0.06, east + 0.06, `Destination ${offset}-${index}`),
        departure: { kind: 'NOW' },
        arriveBy: null,
        preferences: PREFERENCES,
      };
    };

    const started = performance.now();
    const created = await Promise.all(
      clients.map(async (client, index) => {
        const begun = performance.now();
        const result = await httpsCallable<unknown, { tripId: string }>(
          client.functions,
          'createTripRequest',
        )(requestFor(index));
        return { tripId: result.data.tripId, createMs: performance.now() - begun };
      }),
    );

    // When each request first has its estimate. Stops when all have it, when nothing new has arrived
    // for 45 seconds, or after 3 minutes.
    const estimatedAtMs = new Map<string, number>();
    let lastProgress = performance.now();
    while (
      estimatedAtMs.size < created.length &&
      performance.now() - lastProgress < 45_000 &&
      performance.now() - started < 180_000
    ) {
      const docs = await admin().firestore.getAll(
        ...created.map((trip) => admin().firestore.doc(`tripRequests/${trip.tripId}`)),
      );
      for (const doc of docs) {
        if (!estimatedAtMs.has(doc.id) && typeof doc.get('estimatedDistance') === 'number') {
          estimatedAtMs.set(doc.id, performance.now() - started);
          lastProgress = performance.now();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { created, estimatedAtMs };
  }

  it('measures creation, and how many requests get an estimate and when', async () => {
    const fake = await startFakeOsrm();
    fake.reply((request) => ({
      kind: 'delay',
      ms: ROUTE_LATENCY_MS,
      then: { kind: 'route', body: defaultRouteBody(request) },
    }));

    try {
      let offset = 0;
      for (const burst of [10, 25, 50]) {
        const requestsBefore = fake.requests.length;
        const { created, estimatedAtMs } = await runBurst(burst, offset);
        offset += 1;
        const seconds = [...estimatedAtMs.values()].map((ms) => ms / 1000);
        const within = (limit: number) => seconds.filter((s) => s <= limit).length;

        record({
          measure: 'a burst of trip requests, each asked for at the same moment',
          where: 'emulators, real route limits, 150 ms added to every route lookup',
          burst,
          createMedianMs: rounded(
            percentile(
              created.map((c) => c.createMs),
              50,
            ) ?? 0,
          ),
          createP95Ms: rounded(
            percentile(
              created.map((c) => c.createMs),
              95,
            ) ?? 0,
          ),
          createMaxMs: rounded(Math.max(...created.map((c) => c.createMs))),
          estimatedWithin5s: within(5),
          estimatedWithin15s: within(15),
          estimatedWithin60s: within(60),
          estimatedEventually: estimatedAtMs.size,
          neverEstimated: created.length - estimatedAtMs.size,
          lastEstimateAtSeconds: seconds.length ? rounded(Math.max(...seconds)) : null,
          routeLookupsMade: fake.requests.length - requestsBefore,
        });
        expect(created).toHaveLength(burst);
      }
    } finally {
      await fake.close();
    }
  }, 900_000);
});

// ---------------------------------------------------------------------------------------------
// B. What a batch optimization run needs, as the network grows
// ---------------------------------------------------------------------------------------------

const noopPush: PushProvider = { sendPush: () => Promise.resolve({ status: 'sent' }) };
const OPEN = { globalSpacingMs: 0, perCallerPerMinute: 1_000_000 };

function countingProvider() {
  const provider = {
    calls: 0,
    route(stops: RoutePoint[]) {
      provider.calls += 1;
      const legs = stops.slice(1).map((stop, index) => {
        const meters = Math.round(distanceMeters(stops[index]!, stop) * 1.3);
        return { distanceMeters: meters, durationSeconds: Math.round(meters / 12) };
      });
      return Promise.resolve({
        distanceMeters: legs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
        durationSeconds: legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
        geometry: '_p~iF~ps|U',
        legs,
      });
    },
  } satisfies RoutingProvider & { calls: number };
  return provider;
}

describe('B. what a batch optimization run needs, as the network grows', () => {
  // A city-sized box: about 33 km north to south and 35 km east to west.
  const CENTRE = { latitude: 51.5, longitude: -0.1 };
  const HALF_LAT = 0.15;
  const HALF_LON = 0.25;

  async function clearNetwork() {
    const { firestore } = admin();
    for (const name of [
      'driverJourneys',
      'tripRequests',
      'journeyPlans',
      'optimizationRuns',
      'routeCache',
      'routeLimits',
      'routeGlobal',
    ]) {
      await firestore.recursiveDelete(firestore.collection(name));
    }
  }

  async function seedNetwork(size: number, seed: number) {
    const random = randomSequence(seed);
    const now = Timestamp.now();
    const writer = admin().firestore.bulkWriter();
    const near = (point: { latitude: number; longitude: number }, minKm: number, maxKm: number) => {
      const bearing = random() * 2 * Math.PI;
      const km = minKm + random() * (maxKm - minKm);
      return {
        latitude: point.latitude + (Math.cos(bearing) * km) / 111,
        longitude:
          point.longitude +
          (Math.sin(bearing) * km) / (111 * Math.cos((point.latitude * Math.PI) / 180)),
      };
    };
    const inBox = () => ({
      latitude: CENTRE.latitude + (random() * 2 - 1) * HALF_LAT,
      longitude: CENTRE.longitude + (random() * 2 - 1) * HALF_LON,
    });

    for (let i = 0; i < size; i += 1) {
      const driverId = `load-d-${seed}-${i}`;
      const origin = inBox();
      const destination = near(origin, 5, 12);
      void writer.set(admin().firestore.doc(`users/${driverId}`), {
        role: 'DRIVER',
        name: 'Load Driver',
        email: `${driverId}@example.test`,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      void writer.set(admin().firestore.doc(`vehicles/${driverId}`), {
        driverId,
        type: 'CAR',
        make: 'Toyota',
        model: 'Prius',
        plateNumber: `LD${i}`,
        plateKey: `LD${seed}${i}`,
        createdAt: now,
        updatedAt: now,
      });
      void writer.create(admin().firestore.collection('driverJourneys').doc(), {
        driverId,
        vehicleId: driverId,
        status: 'AVAILABLE',
        origin,
        destination,
        availableSeats: 3,
        maxDetourMinutes: 15,
        maxDetourDistance: 8,
        matchedTripRequestIds: [],
        createdAt: now,
        updatedAt: now,
      });
    }
    for (let i = 0; i < size; i += 1) {
      const pickup = inBox();
      const dropoff = near(pickup, 3, 9);
      const meters = distanceMeters(pickup, dropoff) * 1.3;
      void writer.create(admin().firestore.collection('tripRequests').doc(), {
        passengerId: `load-p-${seed}-${i}`,
        passengerName: 'Load',
        status: 'SEARCHING',
        origin: { ...pickup, formattedAddress: `Pickup ${i}`, placeId: null },
        destination: { ...dropoff, formattedAddress: `Dropoff ${i}`, placeId: null },
        passengerPreferences: {
          flexibilityLevel: 'BALANCED',
          maxWalkingDistance: 500,
          maxExtraTime: 15,
          maxDetourDistance: 8,
          allowSharedRide: true,
          allowRouteChange: true,
        },
        arrivalDeadline: null,
        // Already estimated, so the real estimate trigger leaves it alone instead of taking route lookups
        // from the same counters this run is measuring.
        estimatedDistance: Math.round(meters),
        estimatedDuration: Math.round(meters / 12),
        matchedJourneyId: null,
        matchedDriverId: null,
        sharedRide: false,
        createdAt: now,
        updatedAt: now,
      });
    }
    await writer.close();
  }

  it('counts the route lookups and the time for networks of 10 to 100 drivers and requests', async () => {
    const started = await startOptimizationService(60_000).then(
      (running) => ({ running }),
      (error: unknown) => ({ error }),
    );
    if ('error' in started) {
      record({
        measure: 'a batch optimization run, by network size',
        skipped: `the optimization service could not be started: ${String(started.error).slice(0, 160)}`,
      });
      return;
    }
    const service = started.running;

    try {
      for (const size of [10, 25, 50, 100]) {
        await clearNetwork();
        await seedNetwork(size, 1000 + size);
        const provider = countingProvider();

        const started = performance.now();
        const outcome = await runBatchOptimization({
          firestore: admin().firestore,
          provider,
          optimizationService: { baseUrl: service.baseUrl },
          limits: OPEN,
          push: noopPush,
        });
        const durationMs = performance.now() - started;

        record({
          measure: 'a batch optimization run, by network size',
          where: 'emulators, in-process zero-latency routes, the real Python optimization service',
          journeys: size,
          requests: size,
          requestsRead: outcome.requestCount,
          journeysRead: outcome.journeyCount,
          matchedRequests: outcome.matchedRequestCount,
          insertedRequests: outcome.insertedRequestCount,
          routeLookups: provider.calls,
          durationSeconds: rounded(durationMs / 1000),
          // What those lookups cost under the real limit of one every ROUTE_LIMITS.globalSpacingMs for
          // the whole system together, at the very least: the lookups cannot go faster than that.
          minutesAtRealRouteLimit: rounded(
            (provider.calls * ROUTE_LIMITS.globalSpacingMs) / 60_000,
          ),
        });
        expect(outcome.requestCount).toBeGreaterThan(0);
      }
    } finally {
      await service.close();
      await clearNetwork();
    }
  }, 900_000);
});
