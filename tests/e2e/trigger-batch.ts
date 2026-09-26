import { TEST_PORTS } from '../test-ports';
import { FAKE_OSRM_BASE_PATH, FAKE_OSRM_PORT } from '../fake-osrm';

// Fires one batch optimization run (Module 6.9/6.10) directly, the same way phase6-acceptance.int.
// test.ts and optimizationRun.int.test.ts do, rather than waiting for the real scheduled trigger
// (which the emulators do not fire on their own during a test run, and which runs every 2 minutes in
// production - too slow for a test). The optimization service itself is scripted here (a fetchImpl,
// like optimizationRun.int.test.ts): the real Python service and OR-Tools model are Phase 6's own
// acceptance test's job to verify, not this one's - this e2e test is about the real screens and the
// real Firestore trigger chain up to SEARCHING, and what a match looks like once it lands.
//
// process.env.FIRESTORE_EMULATOR_HOST must be set before firebase-admin's first Firestore call, so it
// is set at import time, once, here.
process.env.FIRESTORE_EMULATOR_HOST ??= `127.0.0.1:${TEST_PORTS.firestore}`;
process.env.GCLOUD_PROJECT ??= 'demo-ridemesh';

export interface BatchTriggerScenario {
  tripId: string;
  journeyId: string;
  driverId: string;
}

/**
 * Runs runBatchOptimization for one known request/journey pair, scripting the optimization
 * service's answer to match it (Module 6.1's real candidate filter is skipped - the pair is already
 * known to be a match), and returns once it has been written to Firestore.
 */
export async function triggerBatchOptimization(scenario: BatchTriggerScenario): Promise<void> {
  const { initializeApp, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  // Imported from functions/lib (built by `npm run build:functions`, which `npm run test:e2e` always
  // runs first), not functions/src: Playwright's own module loader does not resolve functions/src's
  // NodeNext-style `./matching.js` imports the way vitest's does when loading a .ts file directly.
  // functions/lib has no declaration files (tsconfig.build.json emits no .d.ts), hence the suppression.
  // @ts-expect-error no .d.ts for the compiled output
  const { runBatchOptimization } = await import('../../functions/lib/optimizationRun.js');
  // @ts-expect-error no .d.ts for the compiled output
  const { createOsrmProvider } = await import('../../functions/lib/routing.js');

  if (getApps().length === 0) initializeApp({ projectId: 'demo-ridemesh' });
  const firestore = getFirestore();

  const provider = createOsrmProvider({
    baseUrls: {
      driving: `http://127.0.0.1:${FAKE_OSRM_PORT}${FAKE_OSRM_BASE_PATH}`,
      walking: '',
    },
    userAgent: 'RideMesh-e2e',
  });

  const script = {
    candidates: {
      candidates: [
        {
          request_id: scenario.tripId,
          journey_id: scenario.journeyId,
          driver_id: scenario.driverId,
          distance_meters: 1,
          bearing_difference_degrees: 0,
        },
      ],
    },
    optimize: {
      plans: [
        {
          journey_id: scenario.journeyId,
          driver_id: scenario.driverId,
          stops: [
            { kind: 'pickup', request_id: scenario.tripId },
            { kind: 'dropoff', request_id: scenario.tripId },
          ],
          request_ids: [scenario.tripId],
          dropped_request_ids: [],
          total_distance_meters: 1000,
          total_duration_seconds: 200,
        },
      ],
      explanations: [],
      validation_issues: [],
      summary: {
        requested_count: 1,
        matched_count: 1,
        dropped_after_sharing_count: 0,
        unmatched_count: 0,
        unmatched_by_reason: {},
        journeys_used: 1,
        total_distance_meters: 1000,
        total_duration_seconds: 200,
        validation_issue_count: 0,
        run_duration_seconds: 0.01,
      },
    },
  };
  const fetchImpl = ((url: string) => {
    const body = url.endsWith('/candidates') ? script.candidates : script.optimize;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;

  await runBatchOptimization({
    firestore,
    provider,
    optimizationService: { baseUrl: 'https://e2e-optimization.example', fetchImpl },
    limits: { globalSpacingMs: 0, perCallerPerMinute: 1_000 },
    // Module 10.3 (trip matched push): this e2e helper is about the Firestore trigger chain, not push
    // delivery (which has its own tests) - a no-op stand-in is enough.
    push: { sendPush: () => Promise.resolve({ status: 'sent' }) },
  });
}
