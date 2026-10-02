import { httpsCallable } from 'firebase/functions';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAnalyticsSummaryForStaff } from '../../functions/src/analytics';
import { getAnalyticsSummary } from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail } from './support';

// Module 12 (Analytics). getAnalyticsSummaryForStaff reads the WHOLE tripRequests/driverJourneys/
// optimizationRuns collections with no scoping - the same "global reader" shape as the batch
// optimization tests (optimizationRun/phase6/8/10-acceptance), so this file clears those collections
// first, the same reason and the same fix, for exact (not >= ) assertions.

let counter = 0;

beforeEach(async () => {
  const { firestore } = admin();
  for (const name of ['tripRequests', 'driverJourneys', 'optimizationRuns']) {
    await firestore.recursiveDelete(firestore.collection(name));
  }
});

async function staff(prefix: string, role = 'ADMIN') {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await admin().auth.setCustomUserClaims(uid, { role });
  await verifyEmail(user, email);
  return { client, uid };
}

async function passenger(prefix: string) {
  const client = createClient();
  const { user, email } = await signUp(client, prefix);
  await httpsCallable(
    client.functions,
    'completeRegistration',
  )({ role: 'PASSENGER', name: 'Test Person' });
  await verifyEmail(user, email);
  return client;
}

async function trip(overrides: Record<string, unknown> = {}): Promise<string> {
  counter += 1;
  const ref = admin().firestore.collection('tripRequests').doc();
  await ref.set({
    passengerId: `passenger-${counter}`,
    matchedDriverId: null,
    status: 'COMPLETED',
    requestedAt: Timestamp.now(),
    createdAt: Timestamp.now(),
    ...overrides,
  });
  return ref.id;
}

async function journey(status: string): Promise<string> {
  counter += 1;
  const ref = admin().firestore.collection('driverJourneys').doc();
  await ref.set({ driverId: `driver-${counter}`, status, createdAt: Timestamp.now() });
  return ref.id;
}

describe('getAnalyticsSummary (functions + firestore + auth emulators)', () => {
  it('lets any staff role view it, and refuses everyone else', async () => {
    for (const role of ['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN']) {
      const caller = await staff(`analytics-role-${role.toLowerCase()}`, role);
      await expect(getAnalyticsSummary(caller.client)).resolves.toBeDefined();
    }
    const passengerClient = await passenger('analytics-role-passenger');
    await expect(getAnalyticsSummary(passengerClient)).rejects.toMatchObject({
      message: 'You are not allowed to view analytics.',
    });
    await expect(
      httpsCallable(createClient().functions, 'getAnalyticsSummary')(),
    ).rejects.toMatchObject({ code: 'functions/unauthenticated' });
  });

  it('counts distinct passengers and vehicles, not raw trip counts, for completed trips', async () => {
    const reviewer = await staff('analytics-distinct-reviewer');
    // 2 trips share one passenger and one driver; a 3rd has both distinct.
    await trip({ passengerId: 'pat', matchedDriverId: 'dan', status: 'COMPLETED' });
    await trip({ passengerId: 'pat', matchedDriverId: 'dan', status: 'COMPLETED' });
    await trip({ passengerId: 'sam', matchedDriverId: 'eve', status: 'COMPLETED' });
    await trip({ passengerId: 'other', matchedDriverId: null, status: 'CANCELLED' });

    const summary = await getAnalyticsSummary(reviewer.client);
    expect(summary.tripsCompleted).toBe(3);
    expect(summary.peopleTransported).toBe(2);
    expect(summary.vehiclesUsed).toBe(2);
  });

  it('computes average occupancy as completed trips over completed journeys', async () => {
    const reviewer = await staff('analytics-occupancy-reviewer');
    await trip({ passengerId: 'a' });
    await trip({ passengerId: 'b' });
    await trip({ passengerId: 'c' });
    await journey('COMPLETED');
    await journey('COMPLETED');
    await journey('DRAFT'); // not completed - excluded from the denominator

    const summary = await getAnalyticsSummary(reviewer.client);
    expect(summary.averageOccupancy).toBeCloseTo(3 / 2);
  });

  it('computes vehicle trips avoided as people transported minus journeys made, never negative', async () => {
    const reviewer = await staff('analytics-avoided-reviewer');
    await trip({ passengerId: 'a' });
    await trip({ passengerId: 'b' });
    await trip({ passengerId: 'c' });
    await journey('COMPLETED');

    const summary = await getAnalyticsSummary(reviewer.client);
    // 3 distinct passengers transported, 1 journey made -> 2 avoided.
    expect(summary.vehicleTripsAvoided).toBe(2);
  });

  it('is null (not zero or negative) when there is nothing to compute an average or rate from', async () => {
    const reviewer = await staff('analytics-empty-reviewer');
    const summary = await getAnalyticsSummary(reviewer.client);
    expect(summary.averageOccupancy).toBeNull();
    expect(summary.averageDetourMeters).toBeNull();
    expect(summary.averageDetourSeconds).toBeNull();
    expect(summary.averageMatchingTimeSeconds).toBeNull();
    expect(summary.cancellationRate).toBeNull();
    expect(summary.paymentSuccessRate).toBeNull();
    expect(summary.estimatedEmissionsAvoidedKg).toBeNull();
    expect(summary.vehicleTripsAvoided).toBe(0);
    expect(summary.tripsCompleted).toBe(0);
  });

  it('counts only currently REQUESTED/SEARCHING trips as unmatched - a live snapshot', async () => {
    const reviewer = await staff('analytics-unmatched-reviewer');
    await trip({ status: 'REQUESTED' });
    await trip({ status: 'SEARCHING' });
    await trip({ status: 'PICKUP_ASSIGNED' });
    await trip({ status: 'COMPLETED' });

    const summary = await getAnalyticsSummary(reviewer.client);
    expect(summary.unmatchedRequests).toBe(2);
  });

  it('computes cancellation rate and payment success rate over resolved/attempted trips only', async () => {
    const reviewer = await staff('analytics-rates-reviewer');
    await trip({ status: 'COMPLETED', paymentStatus: 'CAPTURED' });
    await trip({ status: 'COMPLETED', paymentStatus: 'CAPTURED' });
    await trip({ status: 'COMPLETED', paymentStatus: 'FAILED' });
    await trip({ status: 'CANCELLED', paymentStatus: null });
    await trip({ status: 'SEARCHING', paymentStatus: null }); // still open - excluded from both rates

    const summary = await getAnalyticsSummary(reviewer.client);
    expect(summary.cancellationRate).toBeCloseTo(1 / 4); // 1 cancelled of 4 resolved (3 completed + 1 cancelled)
    expect(summary.paymentSuccessRate).toBeCloseTo(2 / 3); // 2 captured of 3 attempted (2 captured + 1 failed)
  });

  it('averages the real added distance/time of MATCHED decisions from recent optimization runs', async () => {
    const reviewer = await staff('analytics-detour-reviewer');
    await admin()
      .firestore.collection('optimizationRuns')
      .add({
        startedAt: Timestamp.now(),
        decisions: [
          {
            requestId: 'r1',
            status: 'matched',
            additionalDistanceMeters: 1000,
            additionalDurationSeconds: 100,
          },
          {
            requestId: 'r2',
            status: 'matched',
            additionalDistanceMeters: 2000,
            additionalDurationSeconds: 200,
          },
          // Unmatched decisions carry no real distance/time - excluded, not counted as 0.
          {
            requestId: 'r3',
            status: 'unmatched_no_seat_available',
            additionalDistanceMeters: null,
            additionalDurationSeconds: null,
          },
        ],
      });

    const summary = await getAnalyticsSummary(reviewer.client);
    expect(summary.averageDetourMeters).toBeCloseTo(1500);
    expect(summary.averageDetourSeconds).toBeCloseTo(150);
  });

  it('averages real matchDurationSeconds, excluding trips matched before this field existed', async () => {
    const reviewer = await staff('analytics-matching-time-reviewer');
    await trip({ matchDurationSeconds: 60 });
    await trip({ matchDurationSeconds: 120 });
    await trip({}); // matched (in spirit) before this field existed - no matchDurationSeconds at all

    const summary = await getAnalyticsSummary(reviewer.client);
    expect(summary.averageMatchingTimeSeconds).toBeCloseTo(90);
  });

  it('estimates emissions avoided from vehicle trips avoided and the real average trip distance', async () => {
    const reviewer = await staff('analytics-emissions-reviewer');
    await trip({ passengerId: 'a', estimatedDistance: 10_000 });
    await trip({ passengerId: 'b', estimatedDistance: 10_000 });
    await journey('COMPLETED');

    const summary = await getAnalyticsSummary(reviewer.client);
    // 2 people transported - 1 journey = 1 trip avoided; 10 km average; 120 g/km -> 1.2 kg.
    expect(summary.vehicleTripsAvoided).toBe(1);
    expect(summary.estimatedEmissionsAvoidedKg).toBeCloseTo(1.2, 1);
  });
});

// Phase 14 (performance): the distinct counts read the newest N completed trips, not all of them. The
// cap is passed in so a test needs 3 trips, not 5,000; the collections are cleared before each test.
describe('the cap on the distinct counts', () => {
  const caller = { uid: 'cap-reader', role: 'ADMIN', emailVerified: true };
  const summaryWithCap = (cap: number) =>
    getAnalyticsSummaryForStaff({ firestore: admin().firestore, distinctTripCap: cap }, caller);

  /** `count` completed trips, oldest first, each by its own passenger and its own driver. */
  async function completedTrips(count: number) {
    const base = Date.now() - 60_000;
    for (let i = 0; i < count; i += 1) {
      await trip({
        passengerId: `cap-passenger-${i}`,
        matchedDriverId: `cap-driver-${i}`,
        status: 'COMPLETED',
        createdAt: Timestamp.fromMillis(base + i * 1_000),
        estimatedDistance: 10_000,
      });
    }
  }

  it('is exact, with nothing withheld, up to the cap', async () => {
    await completedTrips(3);
    await journey('COMPLETED');

    const summary = await summaryWithCap(3);

    expect(summary).toMatchObject({
      tripsCompleted: 3,
      peopleTransported: 3,
      vehiclesUsed: 3,
      distinctCountsCapped: false,
      distinctTripCap: 3,
      vehicleTripsAvoided: 2,
    });
    expect(summary.estimatedEmissionsAvoidedKg).not.toBeNull();
  });

  it('counts only the newest trips beyond the cap, and says so', async () => {
    await completedTrips(5);
    await journey('COMPLETED');

    const summary = await summaryWithCap(3);

    expect(summary.distinctCountsCapped).toBe(true);
    // The three newest trips: three passengers, three drivers.
    expect(summary.peopleTransported).toBe(3);
    expect(summary.vehiclesUsed).toBe(3);
    // Every completed trip is still counted by the aggregate, which is not capped.
    expect(summary.tripsCompleted).toBe(5);
  });

  it('withholds trips avoided and the emissions estimate instead of showing them wrong', async () => {
    // 5 passengers took 5 trips, all in ONE journey: avoided = 5 - 1 = 4 if the counts were whole. Capped
    // at 3 the people count is 3, and 3 - 1 = 2 would be wrong, so neither number is given.
    await completedTrips(5);
    await journey('COMPLETED');

    const summary = await summaryWithCap(3);

    expect(summary.vehicleTripsAvoided).toBeNull();
    expect(summary.estimatedEmissionsAvoidedKg).toBeNull();
    // What does not depend on the distinct counts is unaffected.
    expect(summary.averageOccupancy).toBe(5);
  });

  it('reads the newest trips: the oldest are the ones left out', async () => {
    // Five trips, passenger i at time i. With a cap of 2 only passengers 3 and 4 may count, so a
    // trip repeated by passenger 0 in the OLD part cannot raise the count.
    await completedTrips(5);
    await trip({
      passengerId: 'cap-passenger-0',
      matchedDriverId: 'cap-driver-0',
      status: 'COMPLETED',
      createdAt: Timestamp.fromMillis(Date.now() - 120_000),
    });

    const summary = await summaryWithCap(2);

    expect(summary.distinctCountsCapped).toBe(true);
    expect(summary.peopleTransported).toBe(2);
    expect(summary.vehiclesUsed).toBe(2);
  });

  it('defaults to 5,000 and does not cap a small database', async () => {
    await completedTrips(2);
    const caller2 = { uid: 'cap-default', role: 'SUPPORT', emailVerified: true };
    const summary = await getAnalyticsSummaryForStaff({ firestore: admin().firestore }, caller2);
    expect(summary.distinctTripCap).toBe(5000);
    expect(summary.distinctCountsCapped).toBe(false);
  });
});
