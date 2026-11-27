import { Timestamp } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { declineMatchedRider, confirmMatchedRider } from '../../functions/src/driverDecision';
import { findCandidateJourneysNow } from '../../functions/src/matching';
import { runBatchOptimization } from '../../functions/src/optimizationRun';
import { tryInsertIntoMatchingJourney } from '../../functions/src/planInsertion';
import { headToPickup } from '../../functions/src/tripExecution';
import { admin } from './support';
import {
  GENEROUS,
  NO_LIMITS,
  clearScenarioCollections,
  geometryOptimizer,
  line,
  positionalProvider,
  recordingPush,
} from './golden/consumer-scenario';

// Module A3b: a company driver may decline a match inside a window (docs/a3b-driver-decline-design.md).
// Silence confirms: a match stands unless the driver declines before its deadline. The world is seeded
// with fixed ids and the stand-in optimizer decides by geometry, as in the characterization test.

const CO = 'dec-co';
const OTHER_CO = 'dec-other-co';

beforeEach(clearScenarioCollections);
afterAll(clearScenarioCollections);

async function seedCompany(id = CO, settings?: Record<string, unknown>) {
  await admin()
    .firestore.doc(`companies/${id}`)
    .set({ name: id, status: 'ACTIVE', ...(settings ? { settings } : {}) });
}

async function seedDriver(label: string, companyId: string | null = CO) {
  const { firestore } = admin();
  await firestore.doc(`users/dec-d-${label}`).set({
    role: companyId ? 'EMPLOYEE' : 'DRIVER',
    name: `Driver ${label}`,
    status: 'ACTIVE',
    ...(companyId ? { companyId } : {}),
  });
  await firestore.doc(`vehicles/dec-d-${label}`).set({
    driverId: `dec-d-${label}`,
    type: 'CAR',
    make: 'Skoda',
    model: 'Octavia',
    plateNumber: `DEC-${label.toUpperCase()}`,
  });
  await firestore
    .doc(`drivers/dec-d-${label}`)
    .set({ userId: `dec-d-${label}`, currentJourneyId: `dec-j-${label}` });
}

async function seedJourney(
  label: string,
  at: number,
  options: { seats?: number; companyId?: string | null } = {},
) {
  const companyId = options.companyId === undefined ? CO : options.companyId;
  await admin()
    .firestore.doc(`driverJourneys/dec-j-${label}`)
    .set({
      driverId: `dec-d-${label}`,
      ...(companyId ? { companyId } : {}),
      status: 'AVAILABLE',
      origin: line(at),
      destination: line(at + 0.05),
      availableSeats: options.seats ?? 2,
      maxDetourMinutes: 60,
      maxDetourDistance: 10,
      matchedTripRequestIds: [],
    });
}

async function seedRider(label: string, from: number, to: number, companyId: string | null = CO) {
  const { firestore } = admin();
  await firestore.doc(`users/dec-p-${label}`).set({
    role: companyId ? 'EMPLOYEE' : 'PASSENGER',
    name: `Rider ${label}`,
    status: 'ACTIVE',
    pushToken: `ExponentPushToken[dec-p-${label}]`,
    ...(companyId ? { companyId } : {}),
  });
  await firestore.doc(`tripRequests/dec-r-${label}`).set({
    passengerId: `dec-p-${label}`,
    passengerName: `Rider ${label}`,
    ...(companyId ? { companyId } : {}),
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
  });
}

const runBatch = (push = recordingPush()) =>
  runBatchOptimization({
    firestore: admin().firestore,
    provider: positionalProvider(),
    limits: NO_LIMITS,
    optimizationService: { baseUrl: 'https://opt.example', fetchImpl: geometryOptimizer() },
    push,
  });

const driver = (label: string, companyId: string | undefined = CO) => ({
  uid: `dec-d-${label}`,
  role: 'DRIVER',
  emailVerified: true,
  ...(companyId ? { companyId } : {}),
});

const deps = (push = recordingPush(), now?: () => number) => ({
  firestore: admin().firestore,
  provider: positionalProvider(),
  limits: NO_LIMITS,
  push,
  ...(now ? { now } : {}),
});

const trip = async (label: string) =>
  (await admin().firestore.doc(`tripRequests/dec-r-${label}`).get()).data();
const journey = async (label: string) =>
  (await admin().firestore.doc(`driverJourneys/dec-j-${label}`).get()).data();
const audits = async (action: string, entity: string) =>
  (
    await admin()
      .firestore.collection('auditLogs')
      .where('action', '==', action)
      .where('entity', '==', entity)
      .get()
  ).size;

/** Company, two drivers on the same line, and one rider matched to the first driver. */
async function matchedWorld() {
  await seedCompany();
  await seedDriver('a');
  await seedDriver('b');
  await seedJourney('a', 52);
  await seedJourney('b', 52);
  await seedRider('1', 52.01, 52.02);
  await runBatch();
}

describe('a company match opens a window to decline', () => {
  it('stamps a company ride with an open window, and a consumer ride with nothing', async () => {
    await matchedWorld();
    // A consumer's journey and rider on another line, matched in the same run.
    await seedDriver('c', null);
    await seedJourney('c', 60, { companyId: null });
    await seedRider('c1', 60.01, 60.02, null);
    await runBatch();

    const before = Date.now();
    const company = await trip('1');
    expect(company).toMatchObject({
      status: 'PICKUP_ASSIGNED',
      matchedJourneyId: 'dec-j-a',
      driverDecision: { status: 'OPEN' },
    });
    const deadline = (company?.driverDecision as { deadline: Timestamp }).deadline.toMillis();
    expect(deadline).toBeGreaterThan(before + 4 * 60_000);
    expect(deadline).toBeLessThanOrEqual(before + 5 * 60_000);

    const consumer = await trip('c1');
    expect(consumer?.status).toBe('PICKUP_ASSIGNED');
    expect(Object.keys(consumer ?? {})).not.toContain('driverDecision');
    expect(Object.keys(consumer ?? {})).not.toContain('declinedJourneyIds');
  });

  it('uses the company’s own window, 0 meaning final at once, and the default for a bad setting', async () => {
    const cases: [unknown, 'OPEN' | 'CONFIRMED', number][] = [
      [0, 'CONFIRMED', 0],
      [15, 'OPEN', 15],
      [30, 'OPEN', 30],
      [31, 'OPEN', 5],
      [-1, 'OPEN', 5],
      [2.5, 'OPEN', 5],
      ['10', 'OPEN', 5],
      [undefined, 'OPEN', 5],
    ];
    for (const [setting, status, minutes] of cases) {
      await clearScenarioCollections();
      await seedCompany(
        CO,
        setting === undefined ? undefined : { driverDeclineWindowMinutes: setting },
      );
      await seedDriver('a');
      await seedJourney('a', 52);
      await seedRider('1', 52.01, 52.02);
      const before = Date.now();
      await runBatch();
      const decision = (await trip('1'))?.driverDecision as { status: string; deadline: Timestamp };
      expect(decision.status, `setting ${String(setting)}`).toBe(status);
      const waited = decision.deadline.toMillis() - before;
      if (minutes === 0) expect(waited).toBeLessThan(60_000);
      else expect(Math.round(waited / 60_000)).toBe(minutes);
    }
  });

  it('opens the same window when a rider is inserted into an already-matching journey', async () => {
    await seedCompany();
    await seedDriver('a');
    await admin()
      .firestore.doc('driverJourneys/dec-j-a')
      .set({
        driverId: 'dec-d-a',
        companyId: CO,
        status: 'MATCHING',
        origin: line(54),
        destination: line(54.05),
        availableSeats: 3,
        maxDetourMinutes: 60,
        maxDetourDistance: 10,
        matchedTripRequestIds: ['dec-r-0'],
      });
    await admin()
      .firestore.doc('journeyPlans/dec-plan-0')
      .set({
        journeyId: 'dec-j-a',
        driverId: 'dec-d-a',
        requestIds: ['dec-r-0'],
        stops: [
          { kind: 'pickup', requestId: 'dec-r-0' },
          { kind: 'dropoff', requestId: 'dec-r-0' },
        ],
        totalDistanceMeters: 5000,
        totalDurationSeconds: 5000,
        version: 1,
        supersedes: null,
        createdAt: new Date(),
      });
    await seedRider('0', 54.01, 54.02);
    await admin().firestore.doc('tripRequests/dec-r-0').update({
      status: 'PICKUP_ASSIGNED',
      matchedJourneyId: 'dec-j-a',
      matchedDriverId: 'dec-d-a',
      assignedPlanId: 'dec-plan-0',
    });
    await seedRider('1', 54.03, 54.04);

    const outcome = await runBatch();
    expect(outcome.insertedRequestCount).toBe(1);
    expect(await trip('1')).toMatchObject({
      status: 'PICKUP_ASSIGNED',
      matchedJourneyId: 'dec-j-a',
      driverDecision: { status: 'OPEN' },
    });
  });
});

describe('declining a match', () => {
  it('releases the rider, tells them, frees the journey, and never offers that driver again', async () => {
    await matchedWorld();
    const push = recordingPush();

    expect(await declineMatchedRider(deps(push), driver('a'), { tripId: 'dec-r-1' })).toEqual({
      status: 'declined',
    });

    const released = await trip('1');
    expect(released).toMatchObject({
      status: 'SEARCHING',
      matchedJourneyId: null,
      matchedDriverId: null,
      assignedPlanId: null,
      driverName: null,
      vehicleType: null,
      vehiclePlateNumber: null,
      declinedJourneyIds: ['dec-j-a'],
      declineCount: 1,
    });
    expect(Object.keys(released ?? {})).not.toContain('driverDecision');
    expect(await journey('a')).toMatchObject({ status: 'AVAILABLE', matchedTripRequestIds: [] });
    expect(await audits('TRIP_DECLINED_BY_DRIVER', 'tripRequests/dec-r-1')).toBe(1);
    const notices = await admin()
      .firestore.collection('notifications')
      .where('recipientId', '==', 'dec-p-1')
      .get();
    expect(notices.docs.map((d) => d.get('type'))).toContain('RELEASED_TO_SEARCHING');
    expect(push.sent).toContainEqual(
      expect.objectContaining({
        token: 'ExponentPushToken[dec-p-1]',
        title: 'Finding a new driver',
      }),
    );

    // The next run matches the rider to the OTHER driver, not back to the one who declined.
    await runBatch();
    expect(await trip('1')).toMatchObject({
      status: 'PICKUP_ASSIGNED',
      matchedJourneyId: 'dec-j-b',
      matchedDriverId: 'dec-d-b',
      declinedJourneyIds: ['dec-j-a'],
    });
  });

  it('leaves the rider searching when the only other journey is the one that declined', async () => {
    await seedCompany();
    await seedDriver('a');
    await seedJourney('a', 52);
    await seedRider('1', 52.01, 52.02);
    await runBatch();
    await declineMatchedRider(deps(), driver('a'), { tripId: 'dec-r-1' });

    const outcome = await runBatch();
    expect(outcome.matchedRequestCount).toBe(0);
    expect(await trip('1')).toMatchObject({ status: 'SEARCHING', matchedJourneyId: null });
    expect(await journey('a')).toMatchObject({ status: 'AVAILABLE' });
  });

  it('keeps the other riders on a revised plan when one of several declines', async () => {
    await seedCompany();
    await seedDriver('a');
    await seedJourney('a', 52);
    await seedRider('1', 52.01, 52.02);
    await seedRider('2', 52.02, 52.03);
    await runBatch();
    expect((await trip('1'))?.assignedPlanId).toBe((await trip('2'))?.assignedPlanId);
    const firstPlan = (await trip('2'))?.assignedPlanId as string;

    await declineMatchedRider(deps(), driver('a'), { tripId: 'dec-r-1' });

    expect(await trip('1')).toMatchObject({ status: 'SEARCHING' });
    const kept = await trip('2');
    expect(kept).toMatchObject({ status: 'PICKUP_ASSIGNED', matchedJourneyId: 'dec-j-a' });
    expect(kept?.assignedPlanId).not.toBe(firstPlan);
    expect(kept?.driverDecision).toMatchObject({ status: 'OPEN' });

    const plan = (
      await admin()
        .firestore.doc(`journeyPlans/${kept?.assignedPlanId as string}`)
        .get()
    ).data();
    expect(plan).toMatchObject({
      version: 2,
      supersedes: firstPlan,
      requestIds: ['dec-r-2'],
      stops: [
        { kind: 'pickup', requestId: 'dec-r-2' },
        { kind: 'dropoff', requestId: 'dec-r-2' },
      ],
    });
    // The legs of the shortened route were worked out, not left empty.
    expect(Array.isArray(plan?.legs)).toBe(true);
    expect(plan?.legs).toHaveLength(2 + 1);
    expect(await journey('a')).toMatchObject({
      status: 'MATCHING',
      matchedTripRequestIds: ['dec-r-2'],
    });
  });

  it('is safe to repeat', async () => {
    await matchedWorld();
    await declineMatchedRider(deps(), driver('a'), { tripId: 'dec-r-1' });
    expect(await declineMatchedRider(deps(), driver('a'), { tripId: 'dec-r-1' })).toEqual({
      status: 'unchanged',
    });
    expect(await audits('TRIP_DECLINED_BY_DRIVER', 'tripRequests/dec-r-1')).toBe(1);
    expect((await trip('1'))?.declineCount).toBe(1);
  });
});

describe('a decline that is refused writes nothing', () => {
  const snapshot = async () => ({ trip: await trip('1'), journey: await journey('a') });

  it('is refused after the window, by anyone else, on a consumer ride, and past pickup', async () => {
    await matchedWorld();
    await seedDriver('c', null);
    await seedJourney('c', 60, { companyId: null });
    await seedRider('c1', 60.01, 60.02, null);
    await runBatch();
    const before = await snapshot();
    const consumerBefore = await trip('c1');

    // After the deadline: the match stands.
    await expect(
      declineMatchedRider(
        deps(recordingPush(), () => Date.now() + 6 * 60_000),
        driver('a'),
        {
          tripId: 'dec-r-1',
        },
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    // Another driver in the same company, a driver of another company, and a consumer driver.
    for (const caller of [driver('b'), driver('a', OTHER_CO), driver('c', undefined)]) {
      await expect(
        declineMatchedRider(deps(), caller, { tripId: 'dec-r-1' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    }
    // A consumer ride, even by its own driver.
    await expect(
      declineMatchedRider(deps(), driver('c', undefined), { tripId: 'dec-r-c1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    // Bad input.
    await expect(declineMatchedRider(deps(), driver('a'), { tripId: '' })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(declineMatchedRider(deps(), driver('a'), {})).rejects.toMatchObject({
      code: 'invalid-argument',
    });

    expect(await snapshot()).toEqual(before);
    expect(await trip('c1')).toEqual(consumerBefore);
    expect(await audits('TRIP_DECLINED_BY_DRIVER', 'tripRequests/dec-r-1')).toBe(0);
  });

  it('is refused once the driver has started towards the pickup', async () => {
    await matchedWorld();
    await headToPickup({ firestore: admin().firestore, push: recordingPush() }, driver('a'), {
      tripId: 'dec-r-1',
    });
    await expect(
      declineMatchedRider(deps(), driver('a'), { tripId: 'dec-r-1' }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect((await trip('1'))?.status).toBe('DRIVER_ARRIVING');
    expect(await journey('a')).toMatchObject({ status: 'MATCHING' });
  });
});

describe('confirming, and silence', () => {
  it('lets the driver accept early, which ends the window', async () => {
    await matchedWorld();
    expect(await confirmMatchedRider(deps(), driver('a'), { tripId: 'dec-r-1' })).toEqual({
      status: 'confirmed',
    });
    expect((await trip('1'))?.driverDecision).toMatchObject({ status: 'CONFIRMED' });
    expect(await audits('TRIP_CONFIRMED_BY_DRIVER', 'tripRequests/dec-r-1')).toBe(1);

    // Safe to repeat, and a decline is now refused although the deadline has not passed.
    expect(await confirmMatchedRider(deps(), driver('a'), { tripId: 'dec-r-1' })).toEqual({
      status: 'unchanged',
    });
    await expect(
      declineMatchedRider(deps(), driver('a'), { tripId: 'dec-r-1' }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect((await trip('1'))?.status).toBe('PICKUP_ASSIGNED');
  });

  it('cannot be done for someone else’s ride', async () => {
    await matchedWorld();
    await expect(
      confirmMatchedRider(deps(), driver('b'), { tripId: 'dec-r-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      confirmMatchedRider(deps(), driver('a', OTHER_CO), { tripId: 'dec-r-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect((await trip('1'))?.driverDecision).toMatchObject({ status: 'OPEN' });
  });

  it('leaves the match standing when nothing is done, with no timer to run', async () => {
    await matchedWorld();
    // Well past the deadline, with nobody having acted: the match is exactly as it was.
    expect(await trip('1')).toMatchObject({
      status: 'PICKUP_ASSIGNED',
      matchedJourneyId: 'dec-j-a',
    });
    // The driver simply carries on, and the pickup proceeds.
    await headToPickup(
      { firestore: admin().firestore, push: recordingPush(), now: () => Date.now() + 60 * 60_000 },
      driver('a'),
      { tripId: 'dec-r-1' },
    );
    expect((await trip('1'))?.status).toBe('DRIVER_ARRIVING');
  });

  it('counts starting the pickup inside the window as accepting', async () => {
    await matchedWorld();
    await headToPickup({ firestore: admin().firestore, push: recordingPush() }, driver('a'), {
      tripId: 'dec-r-1',
    });
    expect((await trip('1'))?.driverDecision).toMatchObject({ status: 'CONFIRMED' });
  });
});

describe('a declined journey is never offered to that rider', () => {
  it('is left out of the candidate pool and out of insertion', async () => {
    await seedCompany();
    await seedDriver('a');
    await seedJourney('a', 52);
    const firestore = admin().firestore;
    const ids = async (exclude: string[]) =>
      (
        await findCandidateJourneysNow(
          { firestore },
          { origin: line(52.001), destination: line(52.04) },
          CO,
          exclude,
        )
      ).map((c) => c.journeyId);
    expect(await ids([])).toEqual(['dec-j-a']);
    expect(await ids(['dec-j-a'])).toEqual([]);

    // Insertion into a matching journey of the same company: allowed, then refused once declined.
    await admin()
      .firestore.doc('driverJourneys/dec-j-a')
      .update({ status: 'MATCHING', matchedTripRequestIds: ['dec-r-0'], availableSeats: 3 });
    await admin()
      .firestore.doc('journeyPlans/dec-plan-0')
      .set({
        journeyId: 'dec-j-a',
        driverId: 'dec-d-a',
        requestIds: ['dec-r-0'],
        stops: [
          { kind: 'pickup', requestId: 'dec-r-0' },
          { kind: 'dropoff', requestId: 'dec-r-0' },
        ],
        totalDistanceMeters: 5000,
        totalDurationSeconds: 5000,
        version: 1,
        supersedes: null,
        createdAt: new Date(),
      });
    await seedRider('0', 52.01, 52.02);
    await admin().firestore.doc('tripRequests/dec-r-0').update({
      status: 'PICKUP_ASSIGNED',
      matchedJourneyId: 'dec-j-a',
      assignedPlanId: 'dec-plan-0',
    });
    await seedRider('1', 52.03, 52.04);
    const request = (declinedJourneyIds: string[]) => ({
      id: 'dec-r-1',
      tenant: CO,
      declinedJourneyIds,
      declineWindowMs: 300_000,
      passengerId: 'dec-p-1',
      origin: line(52.03),
      destination: line(52.04),
      estimatedDistanceMeters: 1000,
      estimatedDurationSeconds: 1000,
      passengerMaxExtraMinutes: GENEROUS.maxExtraTime,
      passengerMaxDetourDistanceKm: GENEROUS.maxDetourDistance,
      allowSharedRide: true,
      allowRouteChange: true,
      arrivalDeadlineMs: null,
    });
    const insertDeps = {
      firestore,
      provider: positionalProvider(),
      push: recordingPush(),
      limits: NO_LIMITS,
    };
    expect(await tryInsertIntoMatchingJourney(insertDeps, request(['dec-j-a']))).toBe('unmatched');
    expect((await trip('1'))?.status).toBe('SEARCHING');
    expect(await tryInsertIntoMatchingJourney(insertDeps, request([]))).toBe('inserted');
    expect((await trip('1'))?.driverDecision).toMatchObject({ status: 'OPEN' });
  });
});
