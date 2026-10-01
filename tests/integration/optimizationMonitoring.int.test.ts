import { httpsCallable } from 'firebase/functions';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTripRequest,
  declareDestination,
  saveVehicle,
  setAvailability,
  setJourneyDetour,
  setJourneyOrigin,
  setJourneySeats,
  setVehicleCapacity,
} from '../../packages/firebase/src';
import { listOptimizationRuns } from '../../packages/firebase/src/optimizationMonitoring';
import { runBatchOptimization } from '../../functions/src/optimizationRun';
import type { PushProvider } from '../../functions/src/pushProvider';
import type { RoutePoint, RoutingProvider } from '../../functions/src/routing';
import { admin, createClient, signUp, verifyEmail } from './support';

// Module 11.9 (admin dashboard: optimization monitoring). listOptimizationRuns is new; the batch
// runner's own matching logic is optimizationRun.int.test.ts's job, not this file's - what's under
// test here is only whether a cycle gets logged (and what it logs), and who may read the log back.
// The same fixtures (driverWithJourney/passengerWithFarRequest/fakeOptimizationFetch) are duplicated
// from that file rather than shared, since neither file exports them.

const NO_LIMITS = { globalSpacingMs: 0, perCallerPerMinute: 1_000 };
const noopPush: PushProvider = { sendPush: () => Promise.resolve({ status: 'sent' }) };

function positionalProvider(): RoutingProvider {
  return {
    route: (stops: RoutePoint[]) => {
      let distance = 0;
      for (let i = 1; i < stops.length; i += 1) {
        distance += Math.round(Math.abs(stops[i]!.latitude - stops[i - 1]!.latitude) * 100_000);
      }
      const legs = stops.slice(1).map((_, i) => {
        const d = Math.round(Math.abs(stops[i + 1]!.latitude - stops[i]!.latitude) * 100_000);
        return { distanceMeters: d, durationSeconds: d };
      });
      return Promise.resolve({
        distanceMeters: distance,
        durationSeconds: distance,
        geometry: '_p~iF~ps|U',
        legs,
      });
    },
  };
}

function fakeOptimizationFetch(script: { candidates: unknown; optimize: unknown }): typeof fetch {
  return vi.fn((url: string) => {
    const body = url.endsWith('/candidates') ? script.candidates : script.optimize;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  const { firestore } = admin();
  for (const name of [
    'routeCache',
    'routeLimits',
    'routeGlobal',
    'tripRequests',
    'driverJourneys',
    'optimizationRuns',
  ]) {
    await firestore.recursiveDelete(firestore.collection(name));
  }
});

let counter = 0;
async function driverWithJourney(seats = 2): Promise<{ uid: string; journeyId: string }> {
  counter += 1;
  const at = 30 + counter * 3;
  const client = createClient();
  const { user, uid, email } = await signUp(client, `opt-mon-d${counter}`);
  await httpsCallable(
    client.functions,
    'completeRegistration',
  )({ role: 'DRIVER', name: 'Test Driver' });
  await verifyEmail(user, email);
  await saveVehicle(client, {
    type: 'CAR',
    make: 'Toyota',
    model: 'Corolla',
    plateNumber: `MON-${Date.now() % 100000}-${counter}`,
  });
  await setVehicleCapacity(client, 4);
  await admin().firestore.doc(`drivers/${uid}`).update({ verificationStatus: 'VERIFIED' });
  await admin().firestore.doc(`vehicles/${uid}`).update({ verificationStatus: 'VERIFIED' });
  await declareDestination(client, {
    latitude: at + 10,
    longitude: 0,
    formattedAddress: 'Destination',
    placeId: null,
  });
  await setJourneyOrigin(client, { latitude: at, longitude: 0 });
  await setJourneySeats(client, seats);
  await setJourneyDetour(client, 60, 30);
  await setAvailability(client, 'ONLINE');

  const driverDoc = await admin().firestore.doc(`drivers/${uid}`).get();
  const journeyId = driverDoc.get('currentJourneyId') as string;
  return { uid, journeyId };
}

async function passengerWithFarRequest(): Promise<{ uid: string; tripId: string }> {
  counter += 1;
  const client = createClient();
  const { user, uid, email } = await signUp(client, `opt-mon-p${counter}`);
  await httpsCallable(
    client.functions,
    'completeRegistration',
  )({ role: 'PASSENGER', name: 'Test Passenger' });
  await verifyEmail(user, email);

  const tripId = await createTripRequest(client, {
    origin: { latitude: -40, longitude: 100, formattedAddress: 'Far pickup', placeId: null },
    destination: {
      latitude: -39,
      longitude: 100,
      formattedAddress: 'Far destination',
      placeId: null,
    },
    departure: { kind: 'NOW' },
    arriveBy: null,
    preferences: {
      flexibilityLevel: 'FLEXIBLE',
      maxWalkingDistance: 1000,
      maxExtraTime: 20,
      maxDetourDistance: 5,
      allowSharedRide: true,
      allowRouteChange: true,
    },
  });

  const stop = Date.now() + 20_000;
  for (;;) {
    const data = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    if (data?.status === 'SEARCHING') break;
    if (Date.now() > stop) throw new Error('Timed out waiting for SEARCHING.');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return { uid, tripId };
}

async function staff(role: string, prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await admin().auth.setCustomUserClaims(uid, { role });
  await verifyEmail(user, email);
  return { client, uid };
}

async function runsCollection() {
  return (await admin().firestore.collection('optimizationRuns').get()).docs;
}

describe('runBatchOptimization writes an optimization-run log', () => {
  it('logs a matched cycle with the real per-decision numbers', async () => {
    const { journeyId, uid: driverId } = await driverWithJourney();
    const { tripId } = await passengerWithFarRequest();

    const script = {
      candidates: {
        candidates: [
          {
            request_id: tripId,
            journey_id: journeyId,
            driver_id: driverId,
            distance_meters: 1000,
            bearing_difference_degrees: 5,
          },
        ],
      },
      optimize: {
        plans: [
          {
            journey_id: journeyId,
            driver_id: driverId,
            stops: [
              { kind: 'pickup', request_id: tripId },
              { kind: 'dropoff', request_id: tripId },
            ],
            request_ids: [tripId],
            dropped_request_ids: [],
            total_distance_meters: 1234,
            total_duration_seconds: 567,
          },
        ],
        explanations: [
          { request_id: tripId, status: 'matched', journey_id: journeyId, reason: 'route overlap' },
        ],
        validation_issues: [],
        summary: {
          requested_count: 1,
          matched_count: 1,
          dropped_after_sharing_count: 0,
          unmatched_count: 0,
          unmatched_by_reason: {},
          journeys_used: 1,
          total_distance_meters: 1234,
          total_duration_seconds: 567,
          validation_issue_count: 0,
          run_duration_seconds: 0.42,
        },
      },
    };

    const outcome = await runBatchOptimization({
      firestore: admin().firestore,
      provider: positionalProvider(),
      limits: NO_LIMITS,
      optimizationService: {
        baseUrl: 'https://opt.example',
        fetchImpl: fakeOptimizationFetch(script),
      },
      push: noopPush,
    });

    const docs = await runsCollection();
    expect(docs).toHaveLength(1);
    // Phase 14 observability (spec section 54's own optimizationRunId correlation ID): the value the
    // caller would log alongside its own Cloud Logging entry is this exact document's own ID - the
    // whole point is that the two can be found from one another.
    expect(outcome.optimizationRunId).toBe(docs[0]!.id);
    const run = docs[0]!.data();
    expect(run).toMatchObject({
      requestsEvaluated: 1,
      journeysEvaluated: 1,
      candidatesGenerated: 1,
      plansGenerated: 1,
      plansRejected: 0,
      finalAssignments: 1,
      journeysMatched: 1,
      executionTimeSeconds: 0.42,
    });
    expect(run.decisions).toHaveLength(1);
    expect(run.decisions[0]).toMatchObject({
      requestId: tripId,
      status: 'matched',
      journeyId,
      driverId,
      reason: 'route overlap',
      seatsUsed: 1,
      seatsAvailable: 2,
      planTotalDistanceMeters: 1234,
      planTotalDurationSeconds: 567,
    });
    expect(typeof run.decisions[0].additionalDistanceMeters).toBe('number');
    expect(typeof run.decisions[0].additionalDurationSeconds).toBe('number');
    // Never fabricated (see this module's own scope note): neither field exists anywhere.
    expect(run.decisions[0]).not.toHaveProperty('compatibility');
    expect(run.decisions[0]).not.toHaveProperty('walkingDistanceMeters');
  });

  it('logs a cycle that evaluated real requests/journeys but found no candidate, with zero downstream counts', async () => {
    // Driver and passenger far enough apart that Module 5.2's own real candidate discovery finds
    // nothing - the same "no candidates" case optimizationRun.int.test.ts's own such tests use.
    await driverWithJourney();
    await passengerWithFarRequest();

    await runBatchOptimization({
      firestore: admin().firestore,
      provider: positionalProvider(),
      limits: NO_LIMITS,
      optimizationService: {
        baseUrl: 'https://opt.example',
        fetchImpl: fakeOptimizationFetch({ candidates: { candidates: [] }, optimize: null }),
      },
      push: noopPush,
    });

    const docs = await runsCollection();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.data()).toMatchObject({
      requestsEvaluated: 1,
      journeysEvaluated: 1,
      candidatesGenerated: 0,
      plansGenerated: 0,
      finalAssignments: 0,
      decisions: [],
    });
  });

  it('logs nothing for an empty cycle (0 requests or 0 journeys)', async () => {
    await runBatchOptimization({
      firestore: admin().firestore,
      provider: positionalProvider(),
      limits: NO_LIMITS,
      optimizationService: {
        baseUrl: 'https://opt.example',
        fetchImpl: fakeOptimizationFetch({ candidates: { candidates: [] }, optimize: null }),
      },
      push: noopPush,
    });

    expect(await runsCollection()).toHaveLength(0);
  });
});

describe('listOptimizationRuns (functions + firestore + auth emulators)', () => {
  it('lets any staff role read it, newest first, and refuses everyone else', async () => {
    const { firestore } = admin();
    await firestore.collection('optimizationRuns').add({
      startedAt: Timestamp.fromMillis(Date.now() - 60_000),
      requestsEvaluated: 1,
      journeysEvaluated: 1,
      candidatesGenerated: 0,
      plansGenerated: 0,
      plansRejected: 0,
      unmatchedByReason: {},
      finalAssignments: 0,
      journeysMatched: 0,
      executionTimeSeconds: 0.1,
      decisions: [],
    });
    await firestore.collection('optimizationRuns').add({
      startedAt: Timestamp.fromMillis(Date.now()),
      requestsEvaluated: 2,
      journeysEvaluated: 2,
      candidatesGenerated: 1,
      plansGenerated: 1,
      plansRejected: 0,
      unmatchedByReason: { unmatched_no_nearby_journey: 1 },
      finalAssignments: 1,
      journeysMatched: 1,
      executionTimeSeconds: 0.2,
      decisions: [],
    });

    for (const role of ['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN']) {
      const reviewer = await staff(role, `opt-mon-list-${role.toLowerCase()}`);
      const rows = await listOptimizationRuns(reviewer.client);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.requestsEvaluated).toBe(2);
      expect(rows[1]?.requestsEvaluated).toBe(1);
    }

    await expect(
      httpsCallable(createClient().functions, 'listOptimizationRuns')(),
    ).rejects.toMatchObject({ code: 'functions/unauthenticated' });

    const passengerClient = createClient();
    const { user, email } = await signUp(passengerClient, 'opt-mon-list-passenger');
    await httpsCallable(
      passengerClient.functions,
      'completeRegistration',
    )({ role: 'PASSENGER', name: 'Test Person' });
    await verifyEmail(user, email);
    await expect(listOptimizationRuns(passengerClient)).rejects.toMatchObject({
      message: 'You are not allowed to view optimization runs.',
    });
  });

  it('excludes a run older than the retention window', async () => {
    const { firestore } = admin();
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await firestore.collection('optimizationRuns').add({
      startedAt: Timestamp.fromMillis(old),
      requestsEvaluated: 9,
      journeysEvaluated: 9,
      candidatesGenerated: 0,
      plansGenerated: 0,
      plansRejected: 0,
      unmatchedByReason: {},
      finalAssignments: 0,
      journeysMatched: 0,
      executionTimeSeconds: 0,
      decisions: [],
    });
    await firestore.collection('optimizationRuns').add({
      startedAt: Timestamp.fromMillis(Date.now()),
      requestsEvaluated: 1,
      journeysEvaluated: 1,
      candidatesGenerated: 0,
      plansGenerated: 0,
      plansRejected: 0,
      unmatchedByReason: {},
      finalAssignments: 0,
      journeysMatched: 0,
      executionTimeSeconds: 0,
      decisions: [],
    });

    const reviewer = await staff('ADMIN', 'opt-mon-retention-reviewer');
    const rows = await listOptimizationRuns(reviewer.client);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestsEvaluated).toBe(1);
  });
});
