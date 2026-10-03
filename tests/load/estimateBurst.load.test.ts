import { Timestamp } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { estimateTripRequest } from '../../functions/src/estimates';
import type { RoutePoint, RoutingProvider } from '../../functions/src/routing';
import { distanceMeters } from '../../functions/src/tripRequests';
import { admin } from '../integration/support';
import { sectionRecorder } from './record';

// Phase 14 (Load testing), scenario A2: a burst of route estimates running AT THE SAME TIME.
//
// load.load.test.ts's own burst goes through the emulator's triggers, and the emulator runs a
// background trigger one invocation at a time (its log shows at most 1 estimateTripRequestOnCreate
// running at any moment), so there every estimate found the route counter free and none ever
// competed. Cloud Functions in production run each event in an instance of its own, concurrently.
// This calls estimateTripRequest, the function that trigger runs, for N trip requests at once, in
// this process, with the REAL route limits (one lookup every 1.1 s for everybody) and the real retry
// (ESTIMATE_BUSY_ATTEMPTS tries, ESTIMATE_BUSY_WAIT_MS apart), which is what production's concurrency
// would do to a burst. It uses a collection of its own for the requests (estimateTripRequest's own
// `collection` option), so the real trigger does not also work on them.

const { reset, record } = sectionRecorder('estimates-run-at-the-same-time');
beforeAll(reset);

// What a real routing server takes to answer. An assumption, not a measurement of any server.
const ROUTE_LATENCY_MS = 150;

function slowProvider() {
  const provider = {
    calls: 0,
    async route(stops: RoutePoint[]) {
      provider.calls += 1;
      await new Promise((resolve) => setTimeout(resolve, ROUTE_LATENCY_MS));
      const legs = stops.slice(1).map((stop, index) => {
        const meters = Math.round(distanceMeters(stops[index]!, stop) * 1.3);
        return { distanceMeters: meters, durationSeconds: Math.round(meters / 12) };
      });
      return {
        distanceMeters: legs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
        durationSeconds: legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
        geometry: '_p~iF~ps|U',
        legs,
      };
    },
  } satisfies RoutingProvider & { calls: number };
  return provider;
}

describe('A2. estimates run at the same time, under the real route limits', () => {
  it('counts how many requests of a burst get an estimate', async () => {
    let offset = 0;
    for (const burst of [10, 25, 50]) {
      offset += 1;
      const collection = `tripRequestsUnderTestLoad_${offset}_${Date.now()}`;
      const now = Timestamp.now();
      const ids: string[] = [];
      for (let i = 0; i < burst; i += 1) {
        const north = 40 + offset * 0.5 + (i % 10) * 0.012;
        const east = 10 + Math.floor(i / 10) * 0.012;
        const ref = admin().firestore.collection(collection).doc();
        await ref.set({
          passengerId: `load-a2-${offset}-${i}`,
          status: 'SEARCHING',
          origin: { latitude: north, longitude: east },
          destination: { latitude: north + 0.06, longitude: east + 0.06 },
          estimatedDistance: null,
          estimatedDuration: null,
          createdAt: now,
          updatedAt: now,
        });
        ids.push(ref.id);
      }

      // Let the previous burst's counter settle, so each burst starts with the route counter free.
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const provider = slowProvider();
      const started = performance.now();
      const outcomes = await Promise.all(
        ids.map((id) =>
          estimateTripRequest({ firestore: admin().firestore, provider, collection }, id),
        ),
      );
      const seconds = (performance.now() - started) / 1000;
      const count = (outcome: string) => outcomes.filter((o) => o === outcome).length;

      record({
        measure: 'a burst of route estimates, all started at the same moment',
        where:
          'in-process, the real estimate function with the real route limits and the real retry, 150 ms added to every lookup',
        burst,
        estimated: count('estimated'),
        unavailable: count('unavailable'),
        otherOutcomes: outcomes.length - count('estimated') - count('unavailable'),
        everyRequestHasAnAnswerAfterSeconds: Math.round(seconds * 10) / 10,
        routeLookupsMade: provider.calls,
      });
      expect(outcomes).toHaveLength(burst);
    }
  }, 300_000);
});
