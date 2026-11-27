import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Timestamp } from 'firebase-admin/firestore';
import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTripRequest,
  declareDestination,
  saveVehicle,
  setJourneyDetour,
  setJourneyOrigin,
  setJourneySeats,
  setVehicleCapacity,
} from '../../packages/firebase/src';
import {
  assignSearchingTripRequest,
  findCandidateJourneysNow,
  matchTripRequest,
} from '../../functions/src/matching';
import { runBatchOptimization } from '../../functions/src/optimizationRun';
import type { PushProvider, SendPushParams } from '../../functions/src/pushProvider';
import type { RoutePoint, RoutingProvider } from '../../functions/src/routing';
import { admin, createClient, signUp, verifyEmail } from './support';

// CHARACTERIZATION TEST for module A3a (docs/a3-company-matching-design.md, section 7). It records, in
// a golden file, exactly what consumer matching does TODAY, so that after the company changes the
// same test must produce the identical file. It was written and its golden file generated BEFORE any
// A3a code, on the unchanged code, in its own commit.
//
// It drives every path A3a touches: the on-create candidate count (matchTripRequest), the candidate
// pool (findCandidateJourneysNow), the single-request assignment (assignSearchingTripRequest), the
// batch run's phase 1 (matching into fresh journeys, pooling two riders into one) and phase 2
// (inserting a rider into an already-matching journey). The world is seeded with fixed ids, so the
// result does not depend on random ids; the stand-in optimizer decides by geometry alone, so it does
// not depend on document order either.
//
// To regenerate the golden file on purpose: UPDATE_GOLDEN=1 (never as part of an A3a change).

const GOLDEN_PATH = join(__dirname, 'golden', 'consumer-matching.golden.json');
const NO_LIMITS = { globalSpacingMs: 0, perCallerPerMinute: 1_000 };
const GENEROUS = {
  maxExtraTime: 60,
  maxDetourDistance: 10,
  allowSharedRide: true,
  allowRouteChange: true,
};

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

function recordingPush(): PushProvider & { sent: SendPushParams[] } {
  const sent: SendPushParams[] = [];
  return {
    sent,
    sendPush: (params) => {
      sent.push(params);
      return Promise.resolve({ status: 'sent' });
    },
  };
}

// ---- A stand-in optimization service that decides by geometry alone -------------------------------
// A request is a candidate for a journey when its pickup lies on the journey's line; each journey takes
// its candidate requests, in id order, up to its seats. Nothing here depends on document order.

type Point = { latitude: number; longitude: number };
interface CandidateBody {
  requests: { id: string; origin: Point; destination: Point }[];
  journeys: {
    id: string;
    driver_id: string;
    origin: Point;
    destination: Point;
    available_seats: number;
  }[];
}
interface OptimizeBody {
  request_ids: string[];
  costs: { request_id: string; journey_id: string; driver_id: string }[];
  available_seats: Record<string, number>;
}

function geometryOptimizer(): typeof fetch {
  return ((url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as CandidateBody & OptimizeBody;
    let payload: unknown;
    if (url.endsWith('/candidates')) {
      const candidates = [];
      for (const request of [...body.requests].sort((a, b) => a.id.localeCompare(b.id))) {
        for (const journey of [...body.journeys].sort((a, b) => a.id.localeCompare(b.id))) {
          const low = Math.min(journey.origin.latitude, journey.destination.latitude);
          const high = Math.max(journey.origin.latitude, journey.destination.latitude);
          if (request.origin.latitude >= low && request.origin.latitude <= high) {
            candidates.push({
              request_id: request.id,
              journey_id: journey.id,
              driver_id: journey.driver_id,
              distance_meters: 1000,
              bearing_difference_degrees: 0,
            });
          }
        }
      }
      payload = { candidates };
    } else {
      const byJourney = new Map<string, { driverId: string; requestIds: string[] }>();
      for (const cost of [...body.costs].sort((a, b) => a.request_id.localeCompare(b.request_id))) {
        const entry = byJourney.get(cost.journey_id) ?? {
          driverId: cost.driver_id,
          requestIds: [],
        };
        const seats = body.available_seats[cost.journey_id] ?? 0;
        if (entry.requestIds.length < seats) entry.requestIds.push(cost.request_id);
        byJourney.set(cost.journey_id, entry);
      }
      const plans = [...byJourney.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([journeyId, entry]) => ({
          journey_id: journeyId,
          driver_id: entry.driverId,
          stops: [
            ...entry.requestIds.map((id) => ({ kind: 'pickup', request_id: id })),
            ...entry.requestIds.map((id) => ({ kind: 'dropoff', request_id: id })),
          ],
          request_ids: entry.requestIds,
          dropped_request_ids: [],
          total_distance_meters: 1000 * entry.requestIds.length,
          total_duration_seconds: 1000 * entry.requestIds.length,
        }));
      const matched = new Map(plans.flatMap((p) => p.request_ids.map((id) => [id, p.journey_id])));
      payload = {
        plans,
        explanations: [...body.request_ids]
          .sort((a, b) => a.localeCompare(b))
          .map((id) =>
            matched.has(id)
              ? {
                  request_id: id,
                  status: 'matched',
                  journey_id: matched.get(id),
                  reason: 'matched',
                }
              : { request_id: id, status: 'unmatched', journey_id: null, reason: 'no_candidate' },
          ),
        validation_issues: [],
        summary: {
          requested_count: body.request_ids.length,
          matched_count: matched.size,
          dropped_after_sharing_count: 0,
          unmatched_count: body.request_ids.length - matched.size,
          unmatched_by_reason: { no_candidate: body.request_ids.length - matched.size },
          journeys_used: plans.length,
          total_distance_meters: 0,
          total_duration_seconds: 0,
          validation_issue_count: 0,
          run_duration_seconds: 0,
        },
      };
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  }) as unknown as typeof fetch;
}

// ---- The seeded consumer world --------------------------------------------------------------------

const P = 'golden-';
const COLLECTIONS_TO_CLEAR = [
  'routeCache',
  'routeLimits',
  'routeGlobal',
  'tripRequests',
  'driverJourneys',
  'journeyPlans',
  'optimizationRuns',
  'goldenTrips',
];

beforeEach(async () => {
  const { firestore } = admin();
  for (const name of COLLECTIONS_TO_CLEAR) {
    await firestore.recursiveDelete(firestore.collection(name));
  }
});

const line = (lat: number) => ({ latitude: lat, longitude: 0 });

async function seedDriver(label: string, vehicleExtras: Record<string, unknown> = {}) {
  const { firestore } = admin();
  await firestore.doc(`users/${P}d-${label}`).set({
    role: 'DRIVER',
    name: `Driver ${label}`,
    status: 'ACTIVE',
    pushToken: `ExponentPushToken[d-${label}]`,
  });
  await firestore.doc(`vehicles/${P}d-${label}`).set({
    driverId: `${P}d-${label}`,
    type: 'CAR',
    make: 'Toyota',
    model: 'Corolla',
    plateNumber: `GLD-${label.toUpperCase()}`,
    ...vehicleExtras,
  });
}

async function seedPassenger(label: string) {
  await admin()
    .firestore.doc(`users/${P}p-${label}`)
    .set({
      role: 'PASSENGER',
      name: `Rider ${label}`,
      status: 'ACTIVE',
      pushToken: `ExponentPushToken[p-${label}]`,
    });
}

async function seedJourney(
  label: string,
  fields: { at: number; seats: number; status?: 'AVAILABLE' | 'MATCHING'; matched?: string[] },
) {
  await admin()
    .firestore.doc(`driverJourneys/${P}j-${label}`)
    .set({
      driverId: `${P}d-${label}`,
      status: fields.status ?? 'AVAILABLE',
      origin: line(fields.at),
      destination: line(fields.at + 0.05),
      availableSeats: fields.seats,
      maxDetourMinutes: 60,
      maxDetourDistance: 10,
      matchedTripRequestIds: fields.matched ?? [],
    });
}

async function seedSearchingRequest(
  label: string,
  from: number,
  to: number,
  extra: Record<string, unknown> = {},
  collection = 'tripRequests',
) {
  await admin()
    .firestore.doc(`${collection}/${P}r-${label}`)
    .set({
      passengerId: `${P}p-${label}`,
      passengerName: `Rider ${label}`,
      status: 'SEARCHING',
      origin: line(from),
      destination: line(to),
      estimatedDistance: 1000,
      estimatedDuration: 1000,
      passengerPreferences: GENEROUS,
      matchedJourneyId: null,
      matchedDriverId: null,
      assignedPlanId: null,
      requestedAt: Timestamp.now(),
      ...extra,
    });
}

const norm = (id: unknown): unknown => (typeof id === 'string' ? id.replace(P, '') : id);

describe('consumer matching, characterized (functions + firestore emulators)', () => {
  it('produces exactly the recorded results across every matching path', async () => {
    const { firestore } = admin();

    // Cluster X: one journey, two riders who pool into it.   Cluster Y: one seat, one rider.
    // Cluster Z: an already-matching journey with a spare seat, and a new rider to insert.
    // Cluster W: a rider whose destination is far beyond the journey. The stand-in optimizer does not
    // enforce detour limits (that is the Python service's job, tested there), so it is matched here.
    // Cluster Q: a rider with no journey anywhere near.      Cluster V: single-request assignment.
    for (const label of ['x', 'y', 'z', 'w', 'v']) await seedDriver(label);
    for (const label of ['x1', 'x2', 'y1', 'z0', 'z1', 'w1', 'q1', 'cnt', 'asg']) {
      await seedPassenger(label);
    }
    await seedJourney('x', { at: 52, seats: 2 });
    await seedJourney('y', { at: 54, seats: 1 });
    await seedJourney('w', { at: 58, seats: 2 });
    await seedJourney('v', { at: 60, seats: 1 });
    await seedJourney('z', { at: 56, seats: 3, status: 'MATCHING', matched: [`${P}r-z0`] });
    await firestore.doc(`journeyPlans/${P}plan-z-1`).set({
      journeyId: `${P}j-z`,
      driverId: `${P}d-z`,
      requestIds: [`${P}r-z0`],
      stops: [
        { kind: 'pickup', requestId: `${P}r-z0` },
        { kind: 'dropoff', requestId: `${P}r-z0` },
      ],
      totalDistanceMeters: 5000,
      totalDurationSeconds: 5000,
      version: 1,
      supersedes: null,
      createdAt: new Date(),
    });
    await seedSearchingRequest('z0', 56.01, 56.02, {
      status: 'PICKUP_ASSIGNED',
      matchedJourneyId: `${P}j-z`,
      matchedDriverId: `${P}d-z`,
      assignedPlanId: `${P}plan-z-1`,
    });
    await seedSearchingRequest('x1', 52.01, 52.02);
    await seedSearchingRequest('x2', 52.02, 52.03);
    await seedSearchingRequest('y1', 54.01, 54.02);
    await seedSearchingRequest('z1', 56.03, 56.04);
    await seedSearchingRequest('w1', 58.01, 59.5);
    await seedSearchingRequest('q1', 40.0, 40.01);

    // The candidate pool, asked directly, before any match changes it.
    const pool = async (origin: Point, destination: Point) =>
      (await findCandidateJourneysNow({ firestore }, { origin, destination })).map((c) => ({
        journey: norm(c.journeyId),
        driver: norm(c.driverId),
        distanceMeters: Math.round(c.distanceMeters),
      }));
    const candidatePool = {
      nearX: await pool(line(52.001), line(52.04)),
      nearYAgainstTheGrain: await pool(line(54.001), line(53.9)),
      nowhere: await pool(line(10), line(10.05)),
    };

    // The on-create candidate count, on a separate collection so the live trigger cannot race it.
    await firestore.doc('goldenTrips/golden-r-cnt').set({
      passengerId: `${P}p-cnt`,
      status: 'REQUESTED',
      origin: line(54.0005),
      destination: line(54.04),
      requestedAt: Timestamp.fromMillis(1_700_000_000_000),
      requestedDepartureTime: Timestamp.fromMillis(1_700_000_000_000),
    });
    const countOutcome = await matchTripRequest(
      { firestore, collection: 'goldenTrips' },
      `${P}r-cnt`,
    );
    const counted = (await firestore.doc('goldenTrips/golden-r-cnt').get()).data();

    // Single-request assignment against its own cluster.
    await seedSearchingRequest('asg', 60.001, 60.04, { candidateCount: 1 }, 'goldenTrips');
    const assignOutcome = await assignSearchingTripRequest(
      {
        firestore,
        provider: positionalProvider(),
        limits: NO_LIMITS,
        collection: 'goldenTrips',
      },
      `${P}r-asg`,
    );
    const assigned = (await firestore.doc('goldenTrips/golden-r-asg').get()).data();
    const assignedJourney = (await firestore.doc(`driverJourneys/${P}j-v`).get()).data();

    // The batch run: phase 1 and phase 2 together.
    const push = recordingPush();
    const outcome = await runBatchOptimization({
      firestore,
      provider: positionalProvider(),
      limits: NO_LIMITS,
      optimizationService: { baseUrl: 'https://opt.example', fetchImpl: geometryOptimizer() },
      push,
    });

    // ---- Normalize everything that was written -----------------------------------------------
    const planDocs = await firestore.collection('journeyPlans').get();
    const planLabel = new Map<string, string>();
    for (const doc of planDocs.docs) {
      planLabel.set(
        doc.id,
        `plan:${norm(doc.get('journeyId')) as string}:v${doc.get('version') as number}`,
      );
    }
    const label = (id: unknown): unknown =>
      typeof id === 'string' ? (planLabel.get(id) ?? norm(id)) : id;

    const trips: Record<string, unknown> = {};
    for (const id of ['x1', 'x2', 'y1', 'z0', 'z1', 'w1', 'q1']) {
      const data = (await firestore.doc(`tripRequests/${P}r-${id}`).get()).data() ?? {};
      trips[id] = {
        status: data.status,
        matchedJourneyId: norm(data.matchedJourneyId),
        matchedDriverId: norm(data.matchedDriverId),
        assignedPlanId: label(data.assignedPlanId),
        driverName: data.driverName ?? null,
        vehicle: [data.vehicleType, data.vehicleMake, data.vehicleModel, data.vehiclePlateNumber],
        sharedRide: data.sharedRide ?? null,
        keys: Object.keys(data).sort(),
      };
    }
    const journeys: Record<string, unknown> = {};
    for (const id of ['x', 'y', 'z', 'w', 'v']) {
      const data = (await firestore.doc(`driverJourneys/${P}j-${id}`).get()).data() ?? {};
      journeys[id] = {
        status: data.status,
        availableSeats: data.availableSeats,
        matchedTripRequestIds: ((data.matchedTripRequestIds ?? []) as string[]).map(norm).sort(),
        matchedTripRequestId: norm(data.matchedTripRequestId) ?? null,
        keys: Object.keys(data).sort(),
      };
    }
    const plans = planDocs.docs
      .map((doc) => {
        const d = doc.data();
        return {
          label: label(doc.id),
          journeyId: norm(d.journeyId),
          driverId: norm(d.driverId),
          requestIds: ((d.requestIds ?? []) as string[]).map(norm),
          stops: ((d.stops ?? []) as { kind: string; requestId: string }[]).map((s) => ({
            kind: s.kind,
            requestId: norm(s.requestId),
          })),
          totalDistanceMeters: d.totalDistanceMeters,
          totalDurationSeconds: d.totalDurationSeconds,
          legs: d.legs ?? null,
          version: d.version,
          supersedes: label(d.supersedes),
        };
      })
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));

    const runs = (await firestore.collection('optimizationRuns').get()).docs.map((doc) => {
      const d = doc.data();
      return {
        requestsEvaluated: d.requestsEvaluated,
        journeysEvaluated: d.journeysEvaluated,
        candidatesGenerated: d.candidatesGenerated,
        plansGenerated: d.plansGenerated,
        plansRejected: d.plansRejected,
        unmatchedByReason: d.unmatchedByReason,
        finalAssignments: d.finalAssignments,
        journeysMatched: d.journeysMatched,
        decisions: ((d.decisions ?? []) as Record<string, unknown>[])
          .map((x) => ({
            requestId: norm(x.requestId),
            status: x.status,
            reason: x.reason,
            journeyId: norm(x.journeyId),
            driverId: norm(x.driverId),
            additionalDistanceMeters: x.additionalDistanceMeters,
            additionalDurationSeconds: x.additionalDurationSeconds,
            seatsUsed: x.seatsUsed,
            seatsAvailable: x.seatsAvailable,
          }))
          .sort((a, b) => String(a.requestId).localeCompare(String(b.requestId))),
      };
    });

    const recipients = ['x1', 'x2', 'y1', 'z0', 'z1', 'x', 'y', 'z'].map((l) =>
      l.length === 1 ? `${P}d-${l}` : `${P}p-${l}`,
    );
    const notifications = (await firestore.collection('notifications').get()).docs
      .filter((doc) => recipients.includes(doc.get('recipientId') as string))
      .map((doc) => ({
        type: doc.get('type'),
        recipient: norm(doc.get('recipientId')),
        message: doc.get('message'),
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    const audit = (await firestore.collection('auditLogs').get()).docs
      .filter((doc) =>
        `${doc.get('entity') as string} ${JSON.stringify(doc.get('newState'))}`.includes(P),
      )
      .map((doc) =>
        JSON.stringify({ action: doc.get('action'), entity: doc.get('entity') }).replace(
          /[A-Za-z0-9]{20}/g,
          (m) => planLabel.get(m) ?? m,
        ),
      )
      .map((s) => s.replaceAll(P, ''))
      .sort();

    const actual = {
      candidatePool,
      onCreateCount: {
        outcome: countOutcome,
        status: counted?.status,
        candidateCount: counted?.candidateCount,
      },
      singleAssignment: {
        outcome: assignOutcome,
        status: assigned?.status,
        matchedJourneyId: norm(assigned?.matchedJourneyId),
        matchedDriverId: norm(assigned?.matchedDriverId),
        journey: {
          status: assignedJourney?.status,
          matchedTripRequestId: norm(assignedJourney?.matchedTripRequestId),
        },
      },
      batch: {
        requestCount: outcome.requestCount,
        journeyCount: outcome.journeyCount,
        matchedRequestCount: outcome.matchedRequestCount,
        matchedJourneyCount: outcome.matchedJourneyCount,
        insertedRequestCount: outcome.insertedRequestCount,
        requestIds: outcome.requestIds.map(norm).sort(),
        planIds: outcome.planIds.map(label).sort(),
        hasRunId: outcome.optimizationRunId !== null,
      },
      trips,
      journeys,
      plans,
      optimizationRuns: runs,
      notifications,
      auditLogs: audit,
      pushes: push.sent
        .map(
          (p) =>
            `${(p.token as string).replace('ExponentPushToken[', '').replace(']', '')} | ${p.title} | ${p.body}`,
        )
        .sort(),
    };

    // JSON round trip so undefined and ordering behave the same as the file.
    const normalized = JSON.parse(JSON.stringify(actual)) as unknown;
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(normalized, null, 2)}\n`);
    }
    expect(existsSync(GOLDEN_PATH), 'the golden file must be committed').toBe(true);
    expect(normalized).toEqual(JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')));
  });
});

// ---- The shape of documents consumers create through the real functions ---------------------------
// Recorded once, from real callables: a consumer's trip request and journey carry exactly these keys
// today, so after A3a they must carry exactly these keys again - in particular no `companyId`, not
// even a null one.

const SHAPE_PATH = join(__dirname, 'golden', 'consumer-document-shapes.golden.json');

describe('consumer document shapes, characterized', () => {
  it('writes the same keys on a consumer trip request and journey as before', async () => {
    const driverClient = createClient();
    const driver = await signUp(driverClient, 'golden-shape-d');
    await httpsCallable(
      driverClient.functions,
      'completeRegistration',
    )({ role: 'DRIVER', name: 'D' });
    await verifyEmail(driver.user, driver.email);
    await saveVehicle(driverClient, {
      type: 'CAR',
      make: 'Toyota',
      model: 'Corolla',
      plateNumber: `SHP-${Date.now() % 100000}`,
    });
    await setVehicleCapacity(driverClient, 4);
    await declareDestination(driverClient, {
      latitude: 70.05,
      longitude: 0,
      formattedAddress: 'Destination',
      placeId: null,
    });
    await setJourneyOrigin(driverClient, { latitude: 70, longitude: 0 });
    await setJourneySeats(driverClient, 2);
    await setJourneyDetour(driverClient, 60, 30);
    const driverDoc = await admin().firestore.doc(`drivers/${driver.uid}`).get();
    const journeyId = driverDoc.get('currentJourneyId') as string;

    const passengerClient = createClient();
    const passenger = await signUp(passengerClient, 'golden-shape-p');
    await httpsCallable(
      passengerClient.functions,
      'completeRegistration',
    )({
      role: 'PASSENGER',
      name: 'P',
    });
    await verifyEmail(passenger.user, passenger.email);
    const tripId = await createTripRequest(passengerClient, {
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
    // Let the request's own triggers finish, so the keys they add are in the record too.
    const stop = Date.now() + 20_000;
    for (;;) {
      const status = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).get('status');
      if (status === 'SEARCHING' || Date.now() > stop) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const tripKeys = Object.keys(
      (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data() ?? {},
    ).sort();
    const journeyKeys = Object.keys(
      (await admin().firestore.doc(`driverJourneys/${journeyId}`).get()).data() ?? {},
    ).sort();

    const actual = { tripRequestKeys: tripKeys, driverJourneyKeys: journeyKeys };
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(dirname(SHAPE_PATH), { recursive: true });
      writeFileSync(SHAPE_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(existsSync(SHAPE_PATH), 'the golden file must be committed').toBe(true);
    expect(actual).toEqual(JSON.parse(readFileSync(SHAPE_PATH, 'utf8')));
    expect(tripKeys).not.toContain('companyId');
    expect(journeyKeys).not.toContain('companyId');
  });
});
