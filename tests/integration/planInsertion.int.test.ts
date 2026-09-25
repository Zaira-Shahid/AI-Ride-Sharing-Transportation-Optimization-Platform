import { beforeEach, describe, expect, it } from 'vitest';
import { tryInsertIntoMatchingJourney } from '../../functions/src/planInsertion';
import type { RoutePoint, RoutingProvider } from '../../functions/src/routing';
import { admin } from './support';

// Modules 8.3/8.4 (plan versioning, new passenger insertion) against the Firestore emulator. A
// stand-in RoutingProvider answers every calculateRoute call with the sum of absolute latitude
// differences between consecutive stops (the same "distance along the latitude axis" trick
// optimizationRun.int.test.ts and matching.int.test.ts's own buildJourneyStopMatrix tests use) - real
// enough to test the insertion search itself (which position is cheapest, whose limits it must
// respect) without needing a real routing server. Every fixture here is built directly with the admin
// SDK (a MATCHING journey, its plan, its existing passenger's own trip request) rather than through
// the real matching pipeline, which has its own tests - this file is only about planInsertion's own
// logic once a journey is already MATCHING.

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
  existingTripId: string;
  /** The latitude this fixture's own cluster starts at (see matchingJourneyWithOnePassenger). */
  base: number;
}

let counter = 0;

// Every fixture gets its own line of latitude, degrees apart - far more than the 5 km proximity
// filter (Module 5.2) could ever bridge - so one test's own MATCHING journey is never mistaken for a
// candidate by another's SEARCHING request left over in the same shared emulator run (the whole
// integration suite shares one Firestore instance; see e.g. optimizationRun.int.test.ts's own note on
// this). Also well away from (0, 0) - calculateRoute's own schema refuses exactly (0, 0) as "no real
// place" (the same convention as every other module's own stops).
function nextClusterBase(): number {
  counter += 1;
  return 50 + counter * 2;
}

/**
 * A MATCHING journey with one existing passenger already in its (version 1) plan: origin at its own
 * cluster's base latitude, the passenger picked up 0.01 degrees on and dropped 0.02 degrees on, the
 * journey's own destination 0.05 degrees on - a straight, already-optimal line, so its own current
 * total is exactly what the three legs add up to (5000, in this provider's units).
 */
async function matchingJourneyWithOnePassenger(
  prefix: string,
  overrides: {
    journeySeats?: number;
    journeyDetourKm?: number;
    passengerLimits?: PassengerLimits;
    passengerEstimatedDistanceMeters?: number;
  } = {},
): Promise<Fixture> {
  const base = nextClusterBase();
  const driverId = `${prefix}-driver-${counter}`;
  const journeyRef = admin().firestore.collection('driverJourneys').doc();
  await journeyRef.set({
    driverId,
    status: 'MATCHING',
    origin: { latitude: base, longitude: 0 },
    destination: { latitude: base + 0.05, longitude: 0 },
    availableSeats: overrides.journeySeats ?? 3,
    maxDetourMinutes: 60,
    maxDetourDistance: overrides.journeyDetourKm ?? 10,
    matchedTripRequestIds: [],
  });

  const existingTripRef = admin().firestore.collection('tripRequests').doc();
  const planRef = admin().firestore.collection('journeyPlans').doc();
  await planRef.set({
    journeyId: journeyRef.id,
    driverId,
    requestIds: [existingTripRef.id],
    stops: [
      { kind: 'pickup', requestId: existingTripRef.id },
      { kind: 'dropoff', requestId: existingTripRef.id },
    ],
    totalDistanceMeters: 5000,
    totalDurationSeconds: 5000,
    version: 1,
    supersedes: null,
    createdAt: new Date(),
  });
  await existingTripRef.set({
    passengerId: `${prefix}-existing-passenger-${counter}`,
    passengerName: 'Pat',
    status: 'PICKUP_ASSIGNED',
    origin: { latitude: base + 0.01, longitude: 0 },
    destination: { latitude: base + 0.02, longitude: 0 },
    estimatedDistance: overrides.passengerEstimatedDistanceMeters ?? 1000,
    estimatedDuration: overrides.passengerEstimatedDistanceMeters ?? 1000,
    passengerPreferences: overrides.passengerLimits ?? GENEROUS,
    matchedJourneyId: journeyRef.id,
    matchedDriverId: driverId,
    assignedPlanId: planRef.id,
  });
  await journeyRef.update({ matchedTripRequestIds: [existingTripRef.id] });

  return {
    journeyId: journeyRef.id,
    driverId,
    oldPlanId: planRef.id,
    existingTripId: existingTripRef.id,
    base,
  };
}

async function searchingRequest(
  prefix: string,
  fields: {
    origin: RoutePoint;
    destination: RoutePoint;
    estimatedDistanceMeters: number;
    limits?: PassengerLimits;
  },
): Promise<string> {
  counter += 1;
  const ref = admin().firestore.collection('tripRequests').doc();
  await ref.set({
    passengerId: `${prefix}-passenger-${counter}`,
    passengerName: 'Sam',
    status: 'SEARCHING',
    origin: fields.origin,
    destination: fields.destination,
    estimatedDistance: fields.estimatedDistanceMeters,
    estimatedDuration: fields.estimatedDistanceMeters,
    passengerPreferences: fields.limits ?? GENEROUS,
    matchedJourneyId: null,
    matchedDriverId: null,
    assignedPlanId: null,
  });
  return ref.id;
}

function insert(tripId: string, request: Awaited<ReturnType<typeof buildInsertable>>) {
  return tryInsertIntoMatchingJourney(
    { firestore: admin().firestore, provider: positionalProvider(), limits: NO_LIMITS },
    { id: tripId, ...request },
  );
}

async function buildInsertable(tripId: string) {
  const data = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
  return {
    passengerId: data?.passengerId as string,
    origin: data?.origin as RoutePoint,
    destination: data?.destination as RoutePoint,
    estimatedDistanceMeters: data?.estimatedDistance as number,
    estimatedDurationSeconds: data?.estimatedDuration as number,
    passengerMaxExtraMinutes: data?.passengerPreferences.maxExtraTime as number,
    passengerMaxDetourDistanceKm: data?.passengerPreferences.maxDetourDistance as number,
    allowSharedRide: data?.passengerPreferences.allowSharedRide as boolean,
    allowRouteChange: data?.passengerPreferences.allowRouteChange as boolean,
    arrivalDeadlineMs: null,
  };
}

describe('tryInsertIntoMatchingJourney (functions + firestore emulators)', () => {
  it('inserts a nearby request after the existing stop, as a new plan version', async () => {
    const fixture = await matchingJourneyWithOnePassenger('insert-ok');
    const tripId = await searchingRequest('insert-ok', {
      origin: { latitude: fixture.base + 0.03, longitude: 0 },
      destination: { latitude: fixture.base + 0.04, longitude: 0 },
      estimatedDistanceMeters: 1000,
    });

    const outcome = await insert(tripId, await buildInsertable(tripId));
    expect(outcome).toBe('inserted');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('PICKUP_ASSIGNED');
    expect(trip?.matchedJourneyId).toBe(fixture.journeyId);
    expect(trip?.matchedDriverId).toBe(fixture.driverId);
    const newPlanId = trip?.assignedPlanId as string;
    expect(newPlanId).not.toBe(fixture.oldPlanId);

    const newPlan = (await admin().firestore.doc(`journeyPlans/${newPlanId}`).get()).data();
    expect(newPlan).toMatchObject({
      version: 2,
      supersedes: fixture.oldPlanId,
      totalDistanceMeters: 5000,
      requestIds: [fixture.existingTripId, tripId],
      stops: [
        { kind: 'pickup', requestId: fixture.existingTripId },
        { kind: 'dropoff', requestId: fixture.existingTripId },
        { kind: 'pickup', requestId: tripId },
        { kind: 'dropoff', requestId: tripId },
      ],
    });

    // The old plan is kept, untouched (Module 8.3: an immutable history).
    const oldPlan = (await admin().firestore.doc(`journeyPlans/${fixture.oldPlanId}`).get()).data();
    expect(oldPlan?.version).toBe(1);

    // The existing passenger's own request now points at the new plan, but its own status and match
    // are otherwise unchanged.
    const existingTrip = (
      await admin().firestore.doc(`tripRequests/${fixture.existingTripId}`).get()
    ).data();
    expect(existingTrip?.assignedPlanId).toBe(newPlanId);
    expect(existingTrip?.status).toBe('PICKUP_ASSIGNED');

    const journey = (
      await admin().firestore.doc(`driverJourneys/${fixture.journeyId}`).get()
    ).data();
    expect(journey?.matchedTripRequestIds).toEqual([fixture.existingTripId, tripId]);
    expect(journey?.status).toBe('MATCHING');

    const planAudit = (
      await admin()
        .firestore.collection('auditLogs')
        .where('entity', '==', `driverJourneys/${fixture.journeyId}`)
        .where('action', '==', 'PLAN_REVISED')
        .get()
    ).docs;
    expect(planAudit).toHaveLength(1);
    const tripAudit = (
      await admin()
        .firestore.collection('auditLogs')
        .where('entity', '==', `tripRequests/${tripId}`)
        .where('action', '==', 'TRIP_INSERTED_INTO_JOURNEY')
        .get()
    ).docs;
    expect(tripAudit).toHaveLength(1);
  });

  it('is unmatched when no MATCHING journey is nearby', async () => {
    await matchingJourneyWithOnePassenger('insert-far');
    const tripId = await searchingRequest('insert-far', {
      origin: { latitude: 50, longitude: 50 },
      destination: { latitude: 50.01, longitude: 50 },
      estimatedDistanceMeters: 1000,
    });

    expect(await insert(tripId, await buildInsertable(tripId))).toBe('unmatched');
    expect((await admin().firestore.doc(`tripRequests/${tripId}`).get()).data()?.status).toBe(
      'SEARCHING',
    );
  });

  it('is unmatched when the journey has no spare seat', async () => {
    const fixture = await matchingJourneyWithOnePassenger('insert-full', { journeySeats: 1 });
    const tripId = await searchingRequest('insert-full', {
      origin: { latitude: fixture.base + 0.03, longitude: 0 },
      destination: { latitude: fixture.base + 0.04, longitude: 0 },
      estimatedDistanceMeters: 1000,
    });

    expect(await insert(tripId, await buildInsertable(tripId))).toBe('unmatched');
  });

  it("is unmatched when it would break the new passenger's own detour limit", async () => {
    const fixture = await matchingJourneyWithOnePassenger('insert-new-limit');
    // Its own direct distance is declared far lower than the 1000 it would actually ride, with no
    // tolerance at all - so every insertion position fails its own check, wherever it lands.
    const tripId = await searchingRequest('insert-new-limit', {
      origin: { latitude: fixture.base + 0.03, longitude: 0 },
      destination: { latitude: fixture.base + 0.04, longitude: 0 },
      estimatedDistanceMeters: 1,
      limits: {
        maxExtraTime: 0,
        maxDetourDistance: 0,
        allowSharedRide: true,
        allowRouteChange: true,
      },
    });

    expect(await insert(tripId, await buildInsertable(tripId))).toBe('unmatched');
    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('SEARCHING');
    expect(trip?.matchedJourneyId).toBeNull();
  });

  it("is unmatched when it would break the existing passenger's own detour limit", async () => {
    // The existing passenger's own declared direct distance is far lower than their real 1000, with
    // no tolerance - unaffected by where the new pair goes, since it is never less than 1000.
    const fixture = await matchingJourneyWithOnePassenger('insert-existing-limit', {
      passengerLimits: {
        maxExtraTime: 0,
        maxDetourDistance: 0,
        allowSharedRide: true,
        allowRouteChange: true,
      },
      passengerEstimatedDistanceMeters: 1,
    });
    const tripId = await searchingRequest('insert-existing-limit', {
      origin: { latitude: fixture.base + 0.03, longitude: 0 },
      destination: { latitude: fixture.base + 0.04, longitude: 0 },
      estimatedDistanceMeters: 1000,
    });

    expect(await insert(tripId, await buildInsertable(tripId))).toBe('unmatched');
    const existingTrip = (
      await admin().firestore.doc(`tripRequests/${fixture.existingTripId}`).get()
    ).data();
    expect(existingTrip?.assignedPlanId).toBe(fixture.oldPlanId);
  });

  it("is unmatched when it would break the driver's own detour limit", async () => {
    const fixture = await matchingJourneyWithOnePassenger('insert-driver-limit', {
      journeyDetourKm: 0,
    });
    // Out of order relative to the existing stops (its dropoff sits before its own pickup on the
    // line), so no insertion position avoids some backtracking - this journey allows none at all.
    const tripId = await searchingRequest('insert-driver-limit', {
      origin: { latitude: fixture.base + 0.03, longitude: 0 },
      destination: { latitude: fixture.base + 0.005, longitude: 0 },
      estimatedDistanceMeters: 2500,
    });

    expect(await insert(tripId, await buildInsertable(tripId))).toBe('unmatched');
  });

  // Module 8.8 (passenger constraint validation): insertion always makes a journey shared (an
  // existing passenger plus the one being inserted), so allowSharedRide gates it for either side.
  it('is unmatched when the new passenger has opted out of sharing a ride', async () => {
    const fixture = await matchingJourneyWithOnePassenger('insert-new-noshare');
    const tripId = await searchingRequest('insert-new-noshare', {
      origin: { latitude: fixture.base + 0.03, longitude: 0 },
      destination: { latitude: fixture.base + 0.04, longitude: 0 },
      estimatedDistanceMeters: 1000,
      limits: { ...GENEROUS, allowSharedRide: false },
    });

    expect(await insert(tripId, await buildInsertable(tripId))).toBe('unmatched');
    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('SEARCHING');
  });

  it('is unmatched when the existing passenger had opted out of sharing a ride', async () => {
    const fixture = await matchingJourneyWithOnePassenger('insert-existing-noshare', {
      passengerLimits: { ...GENEROUS, allowSharedRide: false },
    });
    const tripId = await searchingRequest('insert-existing-noshare', {
      origin: { latitude: fixture.base + 0.03, longitude: 0 },
      destination: { latitude: fixture.base + 0.04, longitude: 0 },
      estimatedDistanceMeters: 1000,
    });

    expect(await insert(tripId, await buildInsertable(tripId))).toBe('unmatched');
    const existingTrip = (
      await admin().firestore.doc(`tripRequests/${fixture.existingTripId}`).get()
    ).data();
    expect(existingTrip?.assignedPlanId).toBe(fixture.oldPlanId);
  });
});
