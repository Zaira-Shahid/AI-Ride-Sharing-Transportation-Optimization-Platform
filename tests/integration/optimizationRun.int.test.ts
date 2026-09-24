import { httpsCallable } from 'firebase/functions';
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
import { runBatchOptimization } from '../../functions/src/optimizationRun';
import type { RoutePoint, RoutingProvider } from '../../functions/src/routing';
import { admin, createClient, signUp, verifyEmail } from './support';

// The batch runner end to end (Module 6.9, Cloud Functions side, part 2), against the Firestore
// emulator: a stand-in RoutingProvider answers checkCandidateRoute/buildJourneyStopMatrix's real
// calculateRoute calls (same "distance along the latitude axis" trick as matching.int.test.ts's own
// buildJourneyStopMatrix tests), and a fake optimizationService.fetchImpl stands in for the Python
// service's two endpoints - this test is about the TS orchestration and the Firestore writes, not
// re-proving the optimization service's own logic (that is tested on the Python side).
//
// Driver and passenger are placed far enough apart that Module 5.2's own real candidate discovery
// finds nothing (candidateCount 0), so Module 5.5's still-active automatic per-request matching never
// attempts to assign this request itself - the batch runner is the only thing that can match it in
// this test, decoupling it from that race.

const NO_LIMITS = { globalSpacingMs: 0, perCallerPerMinute: 1_000 };

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

beforeEach(async () => {
  const { firestore } = admin();
  for (const name of ['routeCache', 'routeLimits', 'routeGlobal']) {
    await firestore.recursiveDelete(firestore.collection(name));
  }
});

let counter = 0;
async function driverWithJourney(seats = 2): Promise<{ uid: string; journeyId: string }> {
  counter += 1;
  const at = 30 + counter * 3;
  const client = createClient();
  const { user, uid, email } = await signUp(client, `opt-run-d${counter}`);
  await httpsCallable(
    client.functions,
    'completeRegistration',
  )({ role: 'DRIVER', name: 'Test Driver' });
  await verifyEmail(user, email);
  await saveVehicle(client, {
    type: 'CAR',
    make: 'Toyota',
    model: 'Corolla',
    plateNumber: `OPT-${Date.now() % 100000}-${counter}`,
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
  const { user, uid, email } = await signUp(client, `opt-run-p${counter}`);
  await httpsCallable(
    client.functions,
    'completeRegistration',
  )({
    role: 'PASSENGER',
    name: 'Test Passenger',
  });
  await verifyEmail(user, email);

  // Nowhere near any driver in this file's own coordinate range (30-90ish latitude, longitude 0) -
  // Module 5.2's real proximity check (5 km) never finds a candidate here.
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

  async function waitForSearching(): Promise<void> {
    const stop = Date.now() + 20_000;
    for (;;) {
      const data = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
      if (data?.status === 'SEARCHING') return;
      if (Date.now() > stop) throw new Error('Timed out waiting for SEARCHING.');
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  await waitForSearching();

  return { uid, tripId };
}

function fakeOptimizationFetch(script: { candidates: unknown; optimize: unknown }): typeof fetch {
  return vi.fn((url: string) => {
    const body = url.endsWith('/candidates') ? script.candidates : script.optimize;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
  }) as unknown as typeof fetch;
}

describe('runBatchOptimization (functions + firestore emulators, stand-in provider and optimization service)', () => {
  it('matches a request and writes a journey plan when the optimization service returns one', async () => {
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
            total_distance_meters: 1000,
            total_duration_seconds: 1000,
          },
        ],
        explanations: [
          { request_id: tripId, status: 'matched', journey_id: journeyId, reason: 'matched' },
        ],
        validation_issues: [],
        summary: {
          requested_count: 1,
          matched_count: 1,
          dropped_after_sharing_count: 0,
          unmatched_count: 0,
          unmatched_by_reason: {},
          journeys_used: 1,
          total_distance_meters: 1000,
          total_duration_seconds: 1000,
          validation_issue_count: 0,
          run_duration_seconds: 0.01,
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
    });

    expect(outcome.matchedRequestCount).toBe(1);
    expect(outcome.matchedJourneyCount).toBe(1);

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('PICKUP_ASSIGNED');
    expect(trip?.matchedJourneyId).toBe(journeyId);
    expect(trip?.matchedDriverId).toBe(driverId);
    expect(typeof trip?.assignedPlanId).toBe('string');
    expect(trip?.driverName).toBe('Test');
    expect(trip?.vehicleType).toBe('CAR');
    expect(trip?.vehicleMake).toBe('Toyota');
    expect(trip?.vehicleModel).toBe('Corolla');
    expect(typeof trip?.vehiclePlateNumber).toBe('string');

    const journey = (await admin().firestore.doc(`driverJourneys/${journeyId}`).get()).data();
    expect(journey?.status).toBe('MATCHING');
    expect(journey?.matchedTripRequestIds).toEqual([tripId]);

    const planId = trip?.assignedPlanId as string;
    const plan = (await admin().firestore.doc(`journeyPlans/${planId}`).get()).data();
    expect(plan?.journeyId).toBe(journeyId);
    expect(plan?.requestIds).toEqual([tripId]);
    expect(plan?.stops).toEqual([
      { kind: 'pickup', requestId: tripId },
      { kind: 'dropoff', requestId: tripId },
    ]);
  });

  it('matches nothing when the optimization service returns no candidates', async () => {
    // Other integration test files in this run leave their own SEARCHING requests and AVAILABLE
    // journeys behind (shared Firestore state across the whole emulator run) - requestCount and
    // journeyCount are real reads and not asserted here for that reason. The matched counts are
    // deterministic regardless: the fake /candidates response below is empty no matter what is
    // actually in Firestore, so nothing can be matched.
    await driverWithJourney();

    const outcome = await runBatchOptimization({
      firestore: admin().firestore,
      provider: positionalProvider(),
      limits: NO_LIMITS,
      optimizationService: {
        baseUrl: 'https://opt.example',
        fetchImpl: fakeOptimizationFetch({ candidates: { candidates: [] }, optimize: null }),
      },
    });

    expect(outcome.matchedRequestCount).toBe(0);
    expect(outcome.matchedJourneyCount).toBe(0);
  });
});
