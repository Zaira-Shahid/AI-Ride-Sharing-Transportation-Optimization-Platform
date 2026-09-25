import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reoptimizeDelayedJourney } from '../../functions/src/routeModification';
import type { RoutePoint, RoutingProvider } from '../../functions/src/routing';
import { admin } from './support';

// Module 8.7 (route modification) against the Firestore emulator. Same stand-in RoutingProvider and
// fake optimization-service fetch as planInsertion.int.test.ts and optimizationRun.int.test.ts: this
// file is about the TS orchestration (which requests are still reorderable, what gets written, who
// gets released) and the Firestore writes, not re-proving the Python service's own plan-generation
// logic (tested on the Python side) or calculateRoute's own real routing.

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

function fakeOptimizeFetch(response: unknown): typeof fetch {
  return vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(response) }),
  ) as unknown as typeof fetch;
}

beforeEach(async () => {
  const { firestore } = admin();
  for (const name of ['routeCache', 'routeLimits', 'routeGlobal']) {
    await firestore.recursiveDelete(firestore.collection(name));
  }
});

interface PassengerLimits {
  maxExtraTime: number;
  maxDetourDistance: number;
  allowSharedRide: boolean;
  allowRouteChange: boolean;
}

const GENEROUS: PassengerLimits = {
  maxExtraTime: 60,
  maxDetourDistance: 10,
  allowSharedRide: true,
  allowRouteChange: true,
};

interface Fixture {
  journeyId: string;
  driverId: string;
  oldPlanId: string;
  tripAId: string;
  tripBId: string;
  base: number;
}

let counter = 0;
function nextClusterBase(): number {
  counter += 1;
  return 60 + counter * 2;
}

/**
 * A MATCHING, delay-flagged journey with two still-waiting passengers (both PICKUP_ASSIGNED, neither
 * picked up - the only case Module 8.7 ever reorders, see routeModification.ts's own file-level note)
 * and a version-1 plan for them. The driver's own currentLocation sits at the cluster base; A's pickup
 * 0.01 on, A's dropoff 0.02 on, B's pickup 0.03 on, B's dropoff 0.04 on, the journey's own destination
 * 0.05 on - already the cheapest order along this straight line, same convention as
 * planInsertion.int.test.ts's own fixture.
 */
async function delayedJourneyWithTwoWaitingPassengers(
  prefix: string,
  overrides: {
    tripALimits?: PassengerLimits;
    tripBLimits?: PassengerLimits;
    tripAArrivalDeadline?: Date;
  } = {},
): Promise<Fixture> {
  const base = nextClusterBase();
  const driverId = `${prefix}-driver-${counter}`;
  const journeyRef = admin().firestore.collection('driverJourneys').doc();
  const tripARef = admin().firestore.collection('tripRequests').doc();
  const tripBRef = admin().firestore.collection('tripRequests').doc();
  const planRef = admin().firestore.collection('journeyPlans').doc();

  await journeyRef.set({
    driverId,
    status: 'MATCHING',
    origin: { latitude: base, longitude: 80 },
    destination: { latitude: base + 0.05, longitude: 80 },
    currentLocation: { latitude: base, longitude: 80, accuracy: 5, updatedAt: new Date() },
    availableSeats: 3,
    maxDetourMinutes: 60,
    maxDetourDistance: 10,
    delay: { extraMinutes: 12 },
    matchedTripRequestIds: [tripARef.id, tripBRef.id],
  });

  await planRef.set({
    journeyId: journeyRef.id,
    driverId,
    requestIds: [tripARef.id, tripBRef.id],
    stops: [
      { kind: 'pickup', requestId: tripARef.id },
      { kind: 'dropoff', requestId: tripARef.id },
      { kind: 'pickup', requestId: tripBRef.id },
      { kind: 'dropoff', requestId: tripBRef.id },
    ],
    totalDistanceMeters: 5000,
    totalDurationSeconds: 5000,
    version: 1,
    supersedes: null,
    createdAt: new Date(Date.now() - 15 * 60_000),
  });

  await tripARef.set({
    passengerId: `${prefix}-passenger-a-${counter}`,
    status: 'PICKUP_ASSIGNED',
    origin: { latitude: base + 0.01, longitude: 80 },
    destination: { latitude: base + 0.02, longitude: 80 },
    estimatedDistance: 1000,
    estimatedDuration: 1000,
    passengerPreferences: overrides.tripALimits ?? GENEROUS,
    arrivalDeadline: overrides.tripAArrivalDeadline ?? null,
    matchedJourneyId: journeyRef.id,
    matchedDriverId: driverId,
    assignedPlanId: planRef.id,
  });
  await tripBRef.set({
    passengerId: `${prefix}-passenger-b-${counter}`,
    status: 'PICKUP_ASSIGNED',
    origin: { latitude: base + 0.03, longitude: 80 },
    destination: { latitude: base + 0.04, longitude: 80 },
    estimatedDistance: 1000,
    estimatedDuration: 1000,
    passengerPreferences: overrides.tripBLimits ?? GENEROUS,
    matchedJourneyId: journeyRef.id,
    matchedDriverId: driverId,
    assignedPlanId: planRef.id,
  });

  return {
    journeyId: journeyRef.id,
    driverId,
    oldPlanId: planRef.id,
    tripAId: tripARef.id,
    tripBId: tripBRef.id,
    base,
  };
}

function reoptimize(fixture: Fixture, optimizeResponse: unknown) {
  return reoptimizeDelayedJourney(
    {
      firestore: admin().firestore,
      provider: positionalProvider(),
      limits: NO_LIMITS,
      optimizationService: {
        baseUrl: 'https://opt.example',
        fetchImpl: fakeOptimizeFetch(optimizeResponse),
      },
    },
    fixture.journeyId,
  );
}

function planResponse(fixture: Fixture, requestIds: string[]) {
  const stops = requestIds.flatMap((id) => [
    { kind: 'pickup', request_id: id },
    { kind: 'dropoff', request_id: id },
  ]);
  return {
    plans: [
      {
        journey_id: fixture.journeyId,
        driver_id: fixture.driverId,
        stops,
        request_ids: requestIds,
        dropped_request_ids:
          requestIds.length < 2
            ? [fixture.tripAId, fixture.tripBId].filter((id) => !requestIds.includes(id))
            : [],
        total_distance_meters: 4000,
        total_duration_seconds: 4000,
      },
    ],
    explanations: [],
    validation_issues: [],
    summary: {
      requested_count: 2,
      matched_count: requestIds.length,
      dropped_after_sharing_count: 2 - requestIds.length,
      unmatched_count: 0,
      unmatched_by_reason: {},
      journeys_used: 1,
      total_distance_meters: 4000,
      total_duration_seconds: 4000,
      validation_issue_count: 0,
      run_duration_seconds: 0.01,
    },
  };
}

describe('reoptimizeDelayedJourney (functions + firestore emulators)', () => {
  it("writes a new plan version from the driver's current position and clears the delay flag", async () => {
    const fixture = await delayedJourneyWithTwoWaitingPassengers('reopt-ok');

    const outcome = await reoptimize(
      fixture,
      planResponse(fixture, [fixture.tripBId, fixture.tripAId]),
    );
    expect(outcome).toBe('reoptimized');

    const journey = (
      await admin().firestore.doc(`driverJourneys/${fixture.journeyId}`).get()
    ).data();
    expect(journey?.delay).toBeNull();
    expect(journey?.matchedTripRequestIds).toEqual([fixture.tripBId, fixture.tripAId]);

    const tripA = (await admin().firestore.doc(`tripRequests/${fixture.tripAId}`).get()).data();
    const tripB = (await admin().firestore.doc(`tripRequests/${fixture.tripBId}`).get()).data();
    expect(tripA?.assignedPlanId).toBe(tripB?.assignedPlanId);
    expect(tripA?.assignedPlanId).not.toBe(fixture.oldPlanId);
    expect(tripA?.status).toBe('PICKUP_ASSIGNED');
    expect(tripA?.driverDelay).toBeNull();

    const newPlan = (
      await admin()
        .firestore.doc(`journeyPlans/${tripA?.assignedPlanId as string}`)
        .get()
    ).data();
    expect(newPlan).toMatchObject({
      version: 2,
      supersedes: fixture.oldPlanId,
      requestIds: [fixture.tripBId, fixture.tripAId],
    });
    expect(Array.isArray(newPlan?.legs)).toBe(true);

    // The old plan is kept, untouched (Module 8.3: an immutable history).
    const oldPlan = (await admin().firestore.doc(`journeyPlans/${fixture.oldPlanId}`).get()).data();
    expect(oldPlan?.version).toBe(1);

    const audit = (
      await admin()
        .firestore.collection('auditLogs')
        .where('entity', '==', `driverJourneys/${fixture.journeyId}`)
        .where('action', '==', 'PLAN_REVISED')
        .get()
    ).docs;
    expect(audit).toHaveLength(1);

    // Module 8.9 (notification): both kept passengers, whose driver's route changed after a delay.
    for (const tripId of [fixture.tripAId, fixture.tripBId]) {
      const notifications = (
        await admin()
          .firestore.collection('notifications')
          .where('relatedEntity', '==', `tripRequests/${tripId}`)
          .get()
      ).docs;
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.data()).toMatchObject({ type: 'ROUTE_UPDATED_AFTER_DELAY' });
    }
  });

  it('releases a passenger the optimizer could not keep back to SEARCHING, keeping the other', async () => {
    const fixture = await delayedJourneyWithTwoWaitingPassengers('reopt-drop');

    const outcome = await reoptimize(fixture, planResponse(fixture, [fixture.tripAId]));
    expect(outcome).toBe('reoptimized');

    const journey = (
      await admin().firestore.doc(`driverJourneys/${fixture.journeyId}`).get()
    ).data();
    expect(journey?.delay).toBeNull();
    expect(journey?.matchedTripRequestIds).toEqual([fixture.tripAId]);

    const tripA = (await admin().firestore.doc(`tripRequests/${fixture.tripAId}`).get()).data();
    expect(tripA?.status).toBe('PICKUP_ASSIGNED');
    expect(tripA?.assignedPlanId).not.toBe(fixture.oldPlanId);

    const tripB = (await admin().firestore.doc(`tripRequests/${fixture.tripBId}`).get()).data();
    expect(tripB?.status).toBe('SEARCHING');
    expect(tripB?.matchedJourneyId).toBeNull();
    expect(tripB?.matchedDriverId).toBeNull();
    expect(tripB?.assignedPlanId).toBeNull();

    const tripBAudit = (
      await admin()
        .firestore.collection('auditLogs')
        .where('entity', '==', `tripRequests/${fixture.tripBId}`)
        .where('action', '==', 'TRIP_UNMATCHED_ROUTE_MODIFICATION')
        .get()
    ).docs;
    expect(tripBAudit).toHaveLength(1);

    // Module 8.9 (notification): the kept passenger (route updated) and the released one (searching
    // again), each their own type.
    const tripANotifications = (
      await admin()
        .firestore.collection('notifications')
        .where('relatedEntity', '==', `tripRequests/${fixture.tripAId}`)
        .get()
    ).docs;
    expect(tripANotifications).toHaveLength(1);
    expect(tripANotifications[0]?.data()).toMatchObject({ type: 'ROUTE_UPDATED_AFTER_DELAY' });
    const tripBNotifications = (
      await admin()
        .firestore.collection('notifications')
        .where('relatedEntity', '==', `tripRequests/${fixture.tripBId}`)
        .get()
    ).docs;
    expect(tripBNotifications).toHaveLength(1);
    expect(tripBNotifications[0]?.data()).toMatchObject({ type: 'RELEASED_TO_SEARCHING' });
  });

  it('is skipped when the journey is no longer flagged delayed', async () => {
    const fixture = await delayedJourneyWithTwoWaitingPassengers('reopt-clear');
    await admin().firestore.doc(`driverJourneys/${fixture.journeyId}`).update({ delay: null });

    const outcome = await reoptimize(
      fixture,
      planResponse(fixture, [fixture.tripBId, fixture.tripAId]),
    );
    expect(outcome).toBe('skipped');

    const trip = (await admin().firestore.doc(`tripRequests/${fixture.tripAId}`).get()).data();
    expect(trip?.assignedPlanId).toBe(fixture.oldPlanId);
  });

  it('is skipped when the journey has fewer than two still-waiting passengers', async () => {
    const fixture = await delayedJourneyWithTwoWaitingPassengers('reopt-single');
    await admin().firestore.doc(`tripRequests/${fixture.tripBId}`).update({ status: 'COMPLETED' });

    const outcome = await reoptimize(fixture, planResponse(fixture, [fixture.tripAId]));
    expect(outcome).toBe('skipped');
  });

  it('is skipped for an ACTIVE journey (a passenger already picked up)', async () => {
    const fixture = await delayedJourneyWithTwoWaitingPassengers('reopt-active');
    await admin().firestore.doc(`driverJourneys/${fixture.journeyId}`).update({ status: 'ACTIVE' });

    const outcome = await reoptimize(
      fixture,
      planResponse(fixture, [fixture.tripBId, fixture.tripAId]),
    );
    expect(outcome).toBe('skipped');
  });

  // Module 8.8 (passenger constraint validation): a re-ordered plan that would carry a passenger past
  // their own hard arriveBy deadline is left unchanged rather than written, the same as any other
  // reason the returned plan could not be used - see routeModification.ts's own note on why this
  // rejects the whole reorder rather than dropping just the one passenger.
  it("leaves the plan unchanged when the new order would miss a passenger's own hard arrival deadline", async () => {
    const fixture = await delayedJourneyWithTwoWaitingPassengers('reopt-deadline', {
      tripAArrivalDeadline: new Date(0),
    });

    const outcome = await reoptimize(
      fixture,
      planResponse(fixture, [fixture.tripBId, fixture.tripAId]),
    );
    expect(outcome).toBe('unchanged');

    const journey = (
      await admin().firestore.doc(`driverJourneys/${fixture.journeyId}`).get()
    ).data();
    expect(journey?.delay).toEqual({ extraMinutes: 12 });
    const trip = (await admin().firestore.doc(`tripRequests/${fixture.tripAId}`).get()).data();
    expect(trip?.assignedPlanId).toBe(fixture.oldPlanId);
  });
});
