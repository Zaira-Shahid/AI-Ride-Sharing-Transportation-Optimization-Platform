import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import {
  assignSearchingTripRequest,
  findCandidateJourneysNow,
  matchTripRequest,
} from '../../../functions/src/matching';
import { runBatchOptimization } from '../../../functions/src/optimizationRun';
import type { PushProvider, SendPushParams } from '../../../functions/src/pushProvider';
import type { RoutePoint, RoutingProvider } from '../../../functions/src/routing';
import { admin } from '../support';

// THE SCENARIO behind the characterization test for module A3a (docs/a3-company-matching-design.md, section 7). It records, in
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
// It is shared by the characterization test (no company data) and the mixed-world test (the same
// consumer world with companies added), which must see the identical consumer result.

export const NO_LIMITS = { globalSpacingMs: 0, perCallerPerMinute: 1_000 };
export const GENEROUS = {
  maxExtraTime: 60,
  maxDetourDistance: 10,
  allowSharedRide: true,
  allowRouteChange: true,
};

export function positionalProvider(): RoutingProvider {
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

export function recordingPush(): PushProvider & { sent: SendPushParams[] } {
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

export function geometryOptimizer(): typeof fetch {
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

export const P = 'golden-';
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

/**
 * The ids the scenario tests use for their own fixed documents. Everything under them is removed before
 * AND after each use, so these tests neither read another test's leftovers nor leave any for another
 * test: a driver-role user left behind here is picked up by the driver-profile backfill test, which
 * creates profiles and audit entries for it.
 */
const OWN_PREFIXES = [P, 'anoise-', 'hostile-', 'pool-', 'count-', 'assign-', 'ins-', 'e2e-'];
const mentionsOwn = (text: string) => OWN_PREFIXES.some((prefix) => text.includes(prefix));

export async function clearScenarioCollections(): Promise<void> {
  const { firestore } = admin();
  for (const name of COLLECTIONS_TO_CLEAR) {
    await firestore.recursiveDelete(firestore.collection(name));
  }
  // The accounts the scenarios seed, by id prefix.
  for (const name of ['users', 'vehicles', 'drivers']) {
    for (const prefix of OWN_PREFIXES) {
      const owned = await firestore
        .collection(name)
        .where(FieldPath.documentId(), '>=', prefix)
        .where(FieldPath.documentId(), '<', `${prefix}\uf8ff`)
        .get();
      await Promise.all(owned.docs.map((doc) => doc.ref.delete()));
    }
  }
  // What was written about them: audit entries (of any action) and notifications. They carry the fixed
  // ids, so a later run would otherwise read an earlier run's entries as its own.
  const audits = await firestore.collection('auditLogs').select('entity', 'newState').get();
  const notices = await firestore.collection('notifications').select('recipientId').get();
  const stale = [
    ...audits.docs.filter((doc) =>
      mentionsOwn(`${doc.get('entity') as string} ${JSON.stringify(doc.get('newState'))}`),
    ),
    ...notices.docs.filter((doc) => mentionsOwn(String(doc.get('recipientId')))),
  ];
  await Promise.all(stale.map((doc) => doc.ref.delete()));
}

export const line = (lat: number) => ({ latitude: lat, longitude: 0 });

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

// ---- Company noise ----------------------------------------------------------------------------------
// Two companies whose journeys and requests sit on the SAME lines as the consumer world, and whose ids
// sort BEFORE the consumers' ('anoise-' < 'golden-'). A world that did not keep companies apart would
// pair them with consumers, and the stand-in optimizer (which fills seats in id order) would let them
// take the consumers' seats.

export const N = 'anoise-';
export const COMPANY_A = 'noise-company-a';
export const COMPANY_B = 'noise-company-b';

async function seedNoiseDriver(label: string, companyId: string) {
  const { firestore } = admin();
  await firestore.doc(`users/${N}d-${label}`).set({
    role: 'EMPLOYEE',
    name: `Employee driver ${label}`,
    status: 'ACTIVE',
    pushToken: `ExponentPushToken[${N}d-${label}]`,
    companyId,
  });
  await firestore.doc(`vehicles/${N}d-${label}`).set({
    driverId: `${N}d-${label}`,
    type: 'CAR',
    make: 'Skoda',
    model: 'Octavia',
    plateNumber: `NSE-${label.toUpperCase()}`,
  });
}

async function seedNoiseRider(label: string, companyId: string) {
  await admin()
    .firestore.doc(`users/${N}p-${label}`)
    .set({
      role: 'EMPLOYEE',
      name: `Employee rider ${label}`,
      status: 'ACTIVE',
      pushToken: `ExponentPushToken[${N}p-${label}]`,
      companyId,
    });
}

async function seedNoiseJourney(
  label: string,
  companyId: string,
  fields: { at: number; seats: number; status?: 'AVAILABLE' | 'MATCHING'; matched?: string[] },
) {
  await admin()
    .firestore.doc(`driverJourneys/${N}j-${label}`)
    .set({
      driverId: `${N}d-${label}`,
      companyId,
      status: fields.status ?? 'AVAILABLE',
      origin: line(fields.at),
      destination: line(fields.at + 0.05),
      availableSeats: fields.seats,
      maxDetourMinutes: 60,
      maxDetourDistance: 10,
      matchedTripRequestIds: fields.matched ?? [],
    });
}

async function seedNoiseRequest(
  label: string,
  companyId: string,
  from: number,
  to: number,
  extra: Record<string, unknown> = {},
) {
  await admin()
    .firestore.doc(`tripRequests/${N}r-${label}`)
    .set({
      passengerId: `${N}p-${label}`,
      passengerName: `Employee ${label}`,
      companyId,
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

async function seedCompanyNoise() {
  const { firestore } = admin();
  for (const label of ['a', 'b', 'c']) {
    await seedNoiseDriver(label, label === 'b' ? COMPANY_B : COMPANY_A);
  }
  for (const label of ['a1', 'b1', 'b2', 'c0', 'c1']) {
    await seedNoiseRider(label, label.startsWith('b') ? COMPANY_B : COMPANY_A);
  }
  // Company A: a journey on the consumers' line at 52, with a rider who fits it exactly.
  await seedNoiseJourney('a', COMPANY_A, { at: 52, seats: 2 });
  await seedNoiseRequest('a1', COMPANY_A, 52.01, 52.02);
  // Company B: a journey on the consumers' line at 54 with a rider, and a second rider on the line at
  // 52 where company B has no journey (it must stay unmatched, not borrow a consumer's or company A's).
  await seedNoiseJourney('b', COMPANY_B, { at: 54, seats: 1 });
  await seedNoiseRequest('b1', COMPANY_B, 54.01, 54.02);
  await seedNoiseRequest('b2', COMPANY_B, 52.03, 52.04);
  // Company A again: an already-matching journey at 56 (the consumers' z line) and a rider to insert.
  await seedNoiseJourney('c', COMPANY_A, {
    at: 56,
    seats: 3,
    status: 'MATCHING',
    matched: [`${N}r-c0`],
  });
  await firestore.doc(`journeyPlans/${N}plan-c-1`).set({
    journeyId: `${N}j-c`,
    driverId: `${N}d-c`,
    requestIds: [`${N}r-c0`],
    stops: [
      { kind: 'pickup', requestId: `${N}r-c0` },
      { kind: 'dropoff', requestId: `${N}r-c0` },
    ],
    totalDistanceMeters: 5000,
    totalDurationSeconds: 5000,
    version: 1,
    supersedes: null,
    createdAt: new Date(),
  });
  await seedNoiseRequest('c0', COMPANY_A, 56.01, 56.02, {
    status: 'PICKUP_ASSIGNED',
    matchedJourneyId: `${N}j-c`,
    matchedDriverId: `${N}d-c`,
    assignedPlanId: `${N}plan-c-1`,
  });
  await seedNoiseRequest('c1', COMPANY_A, 56.03, 56.04);
}

/** What happened to the company documents, for the mixed-world test to check. */
async function readCompanyOutcome() {
  const { firestore } = admin();
  const trips: Record<string, unknown> = {};
  for (const id of ['a1', 'b1', 'b2', 'c0', 'c1']) {
    const data = (await firestore.doc(`tripRequests/${N}r-${id}`).get()).data() ?? {};
    trips[id] = {
      status: data.status,
      matchedJourneyId: data.matchedJourneyId ?? null,
      matchedDriverId: data.matchedDriverId ?? null,
      companyId: data.companyId,
    };
  }
  const journeys: Record<string, unknown> = {};
  for (const id of ['a', 'b', 'c']) {
    const data = (await firestore.doc(`driverJourneys/${N}j-${id}`).get()).data() ?? {};
    journeys[id] = {
      status: data.status,
      matchedTripRequestIds: ((data.matchedTripRequestIds ?? []) as string[]).sort(),
      companyId: data.companyId,
    };
  }
  const plans = (await firestore.collection('journeyPlans').get()).docs
    .filter((doc) => String(doc.get('journeyId')).startsWith(N))
    .map((doc) => ({
      journeyId: doc.get('journeyId') as string,
      version: doc.get('version') as number,
      requestIds: doc.get('requestIds') as string[],
    }));
  const runs = (await firestore.collection('optimizationRuns').get()).docs
    .filter((doc) => doc.get('companyId') !== undefined)
    .map((doc) => doc.get('companyId') as string)
    .sort();
  return { trips, journeys, plans, runCompanyIds: runs };
}

export interface ScenarioOptions {
  /** Seed two companies whose rides overlap the consumers' on purpose. */
  noise?: boolean;
}

/**
 * Runs the whole consumer scenario and returns what it wrote, normalized, restricted to the consumer
 * documents. With `noise`, the same world has companies in it, and `company` says what happened to
 * them.
 */
export async function runConsumerScenario(options: ScenarioOptions = {}) {
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

  // The same world with companies added: every noise document overlaps a consumer one on purpose.
  if (options.noise) await seedCompanyNoise();

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
  const allPlanDocs = await firestore.collection('journeyPlans').get();
  const planDocs = {
    docs: allPlanDocs.docs.filter((doc) => String(doc.get('journeyId')).startsWith(P)),
  };
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

  const allRuns = (await firestore.collection('optimizationRuns').get()).docs;
  const runs = allRuns
    .filter((doc) => doc.get('companyId') === undefined)
    .map((doc) => {
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
      requestIds: outcome.requestIds
        .filter((id) => id.startsWith(P))
        .map(norm)
        .sort(),
      planIds: outcome.planIds
        .filter((id) => planLabel.has(id))
        .map(label)
        .sort(),
      hasRunId: outcome.optimizationRunId !== null,
    },
    trips,
    journeys,
    plans,
    optimizationRuns: runs,
    notifications,
    auditLogs: audit,
    pushes: push.sent
      .filter((p) => /^ExponentPushToken\[(d|p)-/.test(String(p.token)))
      .map(
        (p) =>
          `${(p.token as string).replace('ExponentPushToken[', '').replace(']', '')} | ${p.title} | ${p.body}`,
      )
      .sort(),
  };

  // JSON round trip so undefined and ordering behave the same as a file.
  return {
    consumer: JSON.parse(JSON.stringify(actual)) as unknown,
    company: options.noise ? await readCompanyOutcome() : null,
  };
}
