import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Timestamp } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assignSearchingTripRequest,
  findCandidateJourneysNow,
  matchTripRequest,
} from '../../functions/src/matching';
import { runBatchOptimization } from '../../functions/src/optimizationRun';
import { tryInsertIntoMatchingJourney } from '../../functions/src/planInsertion';
import { tenantOf } from '../../functions/src/tenant';
import { admin } from './support';
import {
  COMPANY_A,
  COMPANY_B,
  GENEROUS,
  NO_LIMITS,
  clearScenarioCollections,
  line,
  positionalProvider,
  recordingPush,
  runConsumerScenario,
} from './golden/consumer-scenario';

// Module A3a: companies and consumers are kept apart by every matching path (docs/a3-company-
// matching-design.md, sections 3 and 7). The consumer result with companies in the same database must be
// exactly the recorded one; company rides must only ever meet their own company; and a pairing across
// companies must be refused even when the optimizer proposes one.

const GOLDEN = JSON.parse(
  readFileSync(join(__dirname, 'golden', 'consumer-matching.golden.json'), 'utf8'),
) as Record<string, unknown>;

type Scenario = Awaited<ReturnType<typeof runConsumerScenario>>;

afterAll(clearScenarioCollections);
interface BatchPart {
  requestIds: string[];
  planIds: string[];
  hasRunId: boolean;
}

describe('the consumer world with two companies in the same database', () => {
  let result: Scenario;

  beforeAll(async () => {
    await clearScenarioCollections();
    result = await runConsumerScenario({ noise: true });
  });

  it('gives every consumer exactly the result recorded before companies existed', () => {
    const { batch: actualBatch, ...actualRest } = result.consumer as Record<string, unknown> & {
      batch: BatchPart;
    };
    const { batch: goldenBatch, ...goldenRest } = GOLDEN as Record<string, unknown> & {
      batch: BatchPart;
    };
    // The candidate pool, the on-create count, the single assignment, every trip, journey and plan, the
    // consumer optimization run, the notifications, the audit entries and the pushes.
    expect(actualRest).toEqual(goldenRest);
    // The batch's own totals include the companies' rides, so only the consumer part is compared.
    expect(actualBatch.requestIds).toEqual(goldenBatch.requestIds);
    expect(actualBatch.planIds).toEqual(goldenBatch.planIds);
    expect(actualBatch.hasRunId).toBe(true);
  });

  it('matches each company only inside itself, on lines the consumers use too', () => {
    const company = result.company!;
    expect(company.trips.a1).toMatchObject({
      status: 'PICKUP_ASSIGNED',
      matchedJourneyId: 'anoise-j-a',
      matchedDriverId: 'anoise-d-a',
      companyId: COMPANY_A,
    });
    expect(company.trips.b1).toMatchObject({
      status: 'PICKUP_ASSIGNED',
      matchedJourneyId: 'anoise-j-b',
      matchedDriverId: 'anoise-d-b',
      companyId: COMPANY_B,
    });
    // Company B has no journey on the line at 52: it stays unmatched rather than borrow a consumer's
    // or company A's, though both are right there.
    expect(company.trips.b2).toMatchObject({ status: 'SEARCHING', matchedJourneyId: null });
    // Company A's new rider is inserted into company A's matching journey, not the consumers' one on
    // the same line.
    expect(company.trips.c1).toMatchObject({
      status: 'PICKUP_ASSIGNED',
      matchedJourneyId: 'anoise-j-c',
      matchedDriverId: 'anoise-d-c',
    });
    expect(company.journeys.a).toMatchObject({
      status: 'MATCHING',
      matchedTripRequestIds: ['anoise-r-a1'],
    });
    expect(company.journeys.c).toMatchObject({
      status: 'MATCHING',
      matchedTripRequestIds: ['anoise-r-c0', 'anoise-r-c1'],
    });
    expect(company.plans).toContainEqual({
      journeyId: 'anoise-j-c',
      version: 2,
      requestIds: ['anoise-r-c0', 'anoise-r-c1'],
    });
  });

  it('logs a separate optimization run for each company, and none for a company inside a consumer run', () => {
    expect(result.company!.runCompanyIds).toEqual([COMPANY_A, COMPANY_B]);
  });

  it('never paired anyone across companies, anywhere in the database', async () => {
    const trips = await admin().firestore.collection('tripRequests').get();
    let matched = 0;
    for (const trip of trips.docs) {
      const journeyId: unknown = trip.get('matchedJourneyId');
      if (typeof journeyId !== 'string') continue;
      matched += 1;
      const journey = await admin().firestore.doc(`driverJourneys/${journeyId}`).get();
      expect(tenantOf(trip.data()), `${trip.id} with ${journeyId}`).toBe(tenantOf(journey.data()));
    }
    expect(matched).toBeGreaterThan(8);
  });
});

// ---- A hostile optimizer -------------------------------------------------------------------------------

describe('a pairing across companies is refused at the commit, whoever proposes it', () => {
  beforeEach(clearScenarioCollections);

  async function seedDriver(id: string, role: string, companyId?: string) {
    const { firestore } = admin();
    await firestore.doc(`users/${id}`).set({
      role,
      name: `Driver ${id}`,
      status: 'ACTIVE',
      ...(companyId ? { companyId } : {}),
    });
    await firestore
      .doc(`vehicles/${id}`)
      .set({ driverId: id, type: 'CAR', make: 'Ford', model: 'Focus', plateNumber: id });
  }

  it('does not commit a company request to a consumer journey that the optimizer names', async () => {
    const { firestore } = admin();
    await seedDriver('hostile-d-consumer', 'DRIVER');
    await seedDriver('hostile-d-a', 'EMPLOYEE', COMPANY_A);
    const journey = (id: string, driverId: string, companyId?: string) =>
      firestore.doc(`driverJourneys/${id}`).set({
        driverId,
        ...(companyId ? { companyId } : {}),
        status: 'AVAILABLE',
        origin: line(52),
        destination: line(52.05),
        availableSeats: 2,
        maxDetourMinutes: 60,
        maxDetourDistance: 10,
        matchedTripRequestIds: [],
      });
    await journey('hostile-j-consumer', 'hostile-d-consumer');
    await journey('hostile-j-a', 'hostile-d-a', COMPANY_A);
    await firestore.doc('tripRequests/hostile-r-a').set({
      passengerId: 'hostile-p-a',
      passengerName: 'Employee',
      companyId: COMPANY_A,
      status: 'SEARCHING',
      origin: line(52.01),
      destination: line(52.02),
      estimatedDistance: 1000,
      estimatedDuration: 1000,
      passengerPreferences: GENEROUS,
      matchedJourneyId: null,
      matchedDriverId: null,
      assignedPlanId: null,
      requestedAt: Timestamp.now(),
    });

    // Proposes the company's own journey as a candidate (so the run goes on), then names the CONSUMER's
    // journey in its plan, a journey the company's group never contained.
    const hostile = ((url: string) => {
      const payload = url.endsWith('/candidates')
        ? {
            candidates: [
              {
                request_id: 'hostile-r-a',
                journey_id: 'hostile-j-a',
                driver_id: 'hostile-d-a',
                distance_meters: 1,
                bearing_difference_degrees: 0,
              },
            ],
          }
        : {
            plans: [
              {
                journey_id: 'hostile-j-consumer',
                driver_id: 'hostile-d-consumer',
                stops: [
                  { kind: 'pickup', request_id: 'hostile-r-a' },
                  { kind: 'dropoff', request_id: 'hostile-r-a' },
                ],
                request_ids: ['hostile-r-a'],
                dropped_request_ids: [],
                total_distance_meters: 1000,
                total_duration_seconds: 1000,
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
              total_distance_meters: 0,
              total_duration_seconds: 0,
              validation_issue_count: 0,
              run_duration_seconds: 0,
            },
          };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    }) as unknown as typeof fetch;

    const outcome = await runBatchOptimization({
      firestore,
      provider: positionalProvider(),
      limits: NO_LIMITS,
      optimizationService: { baseUrl: 'https://opt.example', fetchImpl: hostile },
      push: recordingPush(),
    });

    expect(outcome.matchedRequestCount).toBe(0);
    expect((await firestore.doc('tripRequests/hostile-r-a').get()).data()).toMatchObject({
      status: 'SEARCHING',
      matchedJourneyId: null,
      matchedDriverId: null,
    });
    expect((await firestore.doc('driverJourneys/hostile-j-consumer').get()).data()).toMatchObject({
      status: 'AVAILABLE',
      matchedTripRequestIds: [],
    });
    expect((await firestore.collection('journeyPlans').get()).size).toBe(0);
  });
});

// ---- The pool, the single assignment and insertion, called directly -------------------------------------

describe('the candidate pool and single assignment pair only within a company', () => {
  beforeEach(clearScenarioCollections);

  async function seedJourneyAt(id: string, at: number, companyId?: string) {
    await admin()
      .firestore.doc(`driverJourneys/${id}`)
      .set({
        driverId: `${id}-driver`,
        ...(companyId !== undefined ? { companyId } : {}),
        status: 'AVAILABLE',
        origin: line(at),
        destination: line(at + 0.05),
        availableSeats: 2,
        maxDetourMinutes: 60,
        maxDetourDistance: 10,
        matchedTripRequestIds: [],
      });
  }

  it('offers each trip only the journeys of its own company', async () => {
    const { firestore } = admin();
    await seedJourneyAt('pool-consumer', 52);
    await seedJourneyAt('pool-a', 52, COMPANY_A);
    await seedJourneyAt('pool-b', 52, COMPANY_B);
    const trip = { origin: line(52.001), destination: line(52.04) };
    const ids = async (tenant?: string | null) =>
      (await findCandidateJourneysNow({ firestore }, trip, tenant)).map((c) => c.journeyId);

    expect(await ids(COMPANY_A)).toEqual(['pool-a']);
    expect(await ids(COMPANY_B)).toEqual(['pool-b']);
    expect(await ids(null)).toEqual(['pool-consumer']);
    // Omitting the company means the consumer network, so a forgotten argument can only narrow the pool.
    expect(await ids()).toEqual(['pool-consumer']);
    expect(await ids('some-other-company')).toEqual([]);
  });

  it('counts a company request’s candidates against its own company only', async () => {
    const { firestore } = admin();
    await seedJourneyAt('count-consumer', 52);
    const request = (id: string, companyId?: string) =>
      firestore.doc(`goldenTrips/${id}`).set({
        passengerId: `${id}-p`,
        ...(companyId ? { companyId } : {}),
        status: 'REQUESTED',
        origin: line(52.0005),
        destination: line(52.04),
        requestedAt: Timestamp.fromMillis(1_700_000_000_000),
        requestedDepartureTime: Timestamp.fromMillis(1_700_000_000_000),
      });
    await request('count-a', COMPANY_A);
    await request('count-consumer-trip');
    await matchTripRequest({ firestore, collection: 'goldenTrips' }, 'count-a');
    await matchTripRequest({ firestore, collection: 'goldenTrips' }, 'count-consumer-trip');
    expect((await firestore.doc('goldenTrips/count-a').get()).get('candidateCount')).toBe(0);
    expect(
      (await firestore.doc('goldenTrips/count-consumer-trip').get()).get('candidateCount'),
    ).toBe(1);

    await seedJourneyAt('count-company', 52, COMPANY_A);
    await firestore.doc('goldenTrips/count-a').update({ status: 'REQUESTED' });
    await matchTripRequest({ firestore, collection: 'goldenTrips' }, 'count-a');
    expect((await firestore.doc('goldenTrips/count-a').get()).get('candidateCount')).toBe(1);
  });

  it('assigns a company request to its own company’s journey, never to a consumer’s', async () => {
    const { firestore } = admin();
    await seedJourneyAt('assign-consumer', 52);
    const trip = (id: string, companyId: string) =>
      firestore.doc(`goldenTrips/${id}`).set({
        passengerId: `${id}-p`,
        companyId,
        status: 'SEARCHING',
        candidateCount: 1,
        origin: line(52.001),
        destination: line(52.04),
        estimatedDistance: 1000,
        estimatedDuration: 1000,
        passengerPreferences: GENEROUS,
        matchedJourneyId: null,
        requestedAt: Timestamp.now(),
      });
    const deps = {
      firestore,
      provider: positionalProvider(),
      limits: NO_LIMITS,
      collection: 'goldenTrips',
    };

    await trip('assign-a', COMPANY_A);
    expect(await assignSearchingTripRequest(deps, 'assign-a')).toBe('unmatched');
    expect((await firestore.doc('driverJourneys/assign-consumer').get()).get('status')).toBe(
      'AVAILABLE',
    );

    await seedJourneyAt('assign-company', 52, COMPANY_A);
    expect(await assignSearchingTripRequest(deps, 'assign-a')).toBe('matched');
    expect((await firestore.doc('goldenTrips/assign-a').get()).get('matchedJourneyId')).toBe(
      'assign-company',
    );
    expect((await firestore.doc('driverJourneys/assign-consumer').get()).get('status')).toBe(
      'AVAILABLE',
    );
  });
});

describe('insertion into a matching journey pairs only within a company', () => {
  beforeEach(clearScenarioCollections);

  let cluster = 0;
  /** A MATCHING journey with one existing rider and a spare seat, on its own line of latitude. */
  async function matchingJourney(label: string, companyId?: string) {
    cluster += 1;
    const base = 50 + cluster * 2;
    const { firestore } = admin();
    const tag = companyId ? { companyId } : {};
    await firestore.doc(`driverJourneys/ins-j-${label}`).set({
      driverId: `ins-d-${label}`,
      ...tag,
      status: 'MATCHING',
      origin: line(base),
      destination: line(base + 0.05),
      availableSeats: 3,
      maxDetourMinutes: 60,
      maxDetourDistance: 10,
      matchedTripRequestIds: [`ins-r-${label}-0`],
    });
    await firestore.doc(`users/ins-d-${label}`).set({ name: 'Driver', status: 'ACTIVE' });
    await firestore
      .doc(`vehicles/ins-d-${label}`)
      .set({ type: 'CAR', make: 'Ford', model: 'Focus' });
    await firestore.doc(`journeyPlans/ins-plan-${label}`).set({
      journeyId: `ins-j-${label}`,
      driverId: `ins-d-${label}`,
      requestIds: [`ins-r-${label}-0`],
      stops: [
        { kind: 'pickup', requestId: `ins-r-${label}-0` },
        { kind: 'dropoff', requestId: `ins-r-${label}-0` },
      ],
      totalDistanceMeters: 5000,
      totalDurationSeconds: 5000,
      version: 1,
      supersedes: null,
      createdAt: new Date(),
    });
    await firestore.doc(`tripRequests/ins-r-${label}-0`).set({
      passengerId: `ins-p-${label}-0`,
      passengerName: 'Pat',
      ...tag,
      status: 'PICKUP_ASSIGNED',
      origin: line(base + 0.01),
      destination: line(base + 0.02),
      estimatedDistance: 1000,
      estimatedDuration: 1000,
      passengerPreferences: GENEROUS,
      matchedJourneyId: `ins-j-${label}`,
      matchedDriverId: `ins-d-${label}`,
      assignedPlanId: `ins-plan-${label}`,
    });
    return base;
  }

  async function insertFor(label: string, base: number, tenant?: string) {
    const id = `ins-new-${label}`;
    await admin()
      .firestore.doc(`tripRequests/${id}`)
      .set({
        passengerId: `${id}-p`,
        ...(tenant ? { companyId: tenant } : {}),
        status: 'SEARCHING',
        origin: line(base + 0.03),
        destination: line(base + 0.04),
        estimatedDistance: 1000,
        estimatedDuration: 1000,
        passengerPreferences: GENEROUS,
        matchedJourneyId: null,
        requestedAt: Timestamp.now(),
      });
    return tryInsertIntoMatchingJourney(
      {
        firestore: admin().firestore,
        provider: positionalProvider(),
        push: recordingPush(),
        limits: NO_LIMITS,
      },
      {
        id,
        ...(tenant ? { tenant } : {}),
        passengerId: `${id}-p`,
        origin: line(base + 0.03),
        destination: line(base + 0.04),
        estimatedDistanceMeters: 1000,
        estimatedDurationSeconds: 1000,
        passengerMaxExtraMinutes: GENEROUS.maxExtraTime,
        passengerMaxDetourDistanceKm: GENEROUS.maxDetourDistance,
        allowSharedRide: true,
        allowRouteChange: true,
        arrivalDeadlineMs: null,
      },
    );
  }

  it('inserts a rider into a journey of their own company, and into no other', async () => {
    const consumerBase = await matchingJourney('consumer');
    const companyBase = await matchingJourney('a', COMPANY_A);
    const otherBase = await matchingJourney('b', COMPANY_B);

    // Each rider sits right behind one journey's stops, with every other company's journey also free.
    expect(await insertFor('consumer', consumerBase)).toBe('inserted');
    expect(await insertFor('a', companyBase, COMPANY_A)).toBe('inserted');
    expect(await insertFor('b', otherBase, COMPANY_B)).toBe('inserted');
    const journeyOf = async (id: string) =>
      (await admin().firestore.doc(`tripRequests/${id}`).get()).get('matchedJourneyId');
    expect(await journeyOf('ins-new-consumer')).toBe('ins-j-consumer');
    expect(await journeyOf('ins-new-a')).toBe('ins-j-a');
    expect(await journeyOf('ins-new-b')).toBe('ins-j-b');
  });

  it('never inserts a company rider into a consumer journey, or the reverse, even right next to it', async () => {
    const consumerBase = await matchingJourney('consumer');
    const companyBase = await matchingJourney('a', COMPANY_A);

    // A company rider right behind the CONSUMER's stops, with no company journey there.
    expect(await insertFor('wrong-a', consumerBase, COMPANY_A)).toBe('unmatched');
    // A consumer rider right behind the COMPANY's stops, with no consumer journey there.
    expect(await insertFor('wrong-consumer', companyBase)).toBe('unmatched');
    // And a rider of a third company next to either.
    expect(await insertFor('wrong-b', companyBase, COMPANY_B)).toBe('unmatched');

    for (const id of ['ins-new-wrong-a', 'ins-new-wrong-consumer', 'ins-new-wrong-b']) {
      expect((await admin().firestore.doc(`tripRequests/${id}`).get()).get('status')).toBe(
        'SEARCHING',
      );
    }
    for (const id of ['consumer', 'a']) {
      expect(
        (await admin().firestore.doc(`driverJourneys/ins-j-${id}`).get()).get('availableSeats'),
      ).toBe(3);
    }
  });
});
