import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import {
  retryDelayedJourneys,
  retryStaleAuthorizedHolds,
  retryStuckRequestedTrips,
} from '../../functions/src/failureRecovery';
import type { RoutingProvider } from '../../functions/src/routing';
import type { StripeProvider } from '../../functions/src/stripeProvider';
import { admin } from './support';

// Phase 14 (Failure recovery). Each sweep reuses an already-tested idempotent function
// (matchTripRequest, reoptimizeDelayedJourney, voidStaleAuthorization - each has its own full test
// file); these tests are about the SWEEP's own responsibility - which stuck records it finds, which
// it correctly leaves alone, and that it counts outcomes correctly - not re-proving those functions'
// own logic.

let counter = 0;

function fakeStripe(overrides: Partial<StripeProvider> = {}): StripeProvider {
  return {
    ping: async () => true,
    createCustomer: async () => 'cus_fake',
    authorizePayment: async () => ({ status: 'authorized', paymentIntentId: 'pi_fake' }),
    capturePayment: async () => ({ status: 'captured' }),
    voidPayment: async () => ({ status: 'voided' }),
    refundPayment: async () => ({ status: 'refunded' }),
    verifyWebhookEvent: () => ({ status: 'invalid' }),
    ...overrides,
  };
}

const NOWHERE_PROVIDER: RoutingProvider = { route: () => Promise.resolve(null) };

describe('retryStuckRequestedTrips', () => {
  // A dedicated collection, never 'tripRequests': creating a real tripRequests doc anywhere in this
  // suite fires the real matchTripRequestOnCreate trigger (the whole suite shares one long-lived
  // Functions+Firestore emulator), which races to move ANY newly-created REQUESTED doc to SEARCHING
  // immediately - regardless of a backdated createdAt meant to make a fixture merely LOOK old to this
  // sweep's own query. retryStuckRequestedTrips accepts the same collection override
  // matchTripRequest itself already does, for exactly this reason.
  const TEST_COLLECTION = 'tripRequestsUnderTestFailureRecovery';
  const deps = { firestore: admin().firestore, collection: TEST_COLLECTION };

  async function requestedTrip(prefix: string, ageMs: number): Promise<string> {
    counter += 1;
    const ref = admin().firestore.collection(TEST_COLLECTION).doc();
    const createdAt = Timestamp.fromMillis(Date.now() - ageMs);
    await ref.set({
      passengerId: `${prefix}-passenger-${counter}`,
      status: 'REQUESTED',
      origin: { latitude: 51.5, longitude: -0.1 },
      destination: { latitude: 51.6, longitude: -0.2 },
      requestedAt: createdAt,
      requestedDepartureTime: createdAt,
      createdAt,
    });
    return ref.id;
  }

  it('starts a REQUESTED trip older than the threshold, moving it to SEARCHING', async () => {
    const tripId = await requestedTrip('stuck', 10 * 60_000);

    const outcome = await retryStuckRequestedTrips(deps);

    expect(outcome.checked).toBeGreaterThanOrEqual(1);
    expect(outcome.started).toBeGreaterThanOrEqual(1);
    const trip = (await admin().firestore.doc(`${TEST_COLLECTION}/${tripId}`).get()).data();
    expect(trip?.status).toBe('SEARCHING');
  });

  it('leaves a REQUESTED trip younger than the threshold alone', async () => {
    const tripId = await requestedTrip('fresh', 1_000);

    await retryStuckRequestedTrips(deps);

    const trip = (await admin().firestore.doc(`${TEST_COLLECTION}/${tripId}`).get()).data();
    expect(trip?.status).toBe('REQUESTED');
  });

  it('leaves an already-SEARCHING trip alone', async () => {
    counter += 1;
    const ref = admin().firestore.collection(TEST_COLLECTION).doc();
    await ref.set({
      passengerId: `searching-passenger-${counter}`,
      status: 'SEARCHING',
      createdAt: Timestamp.fromMillis(Date.now() - 10 * 60_000),
    });
    // Computed BEFORE the sweep runs, with the same 5-minute cutoff retryStuckRequestedTrips itself
    // uses: this file's own earlier tests may have left old REQUESTED fixtures in this same isolated
    // collection too - what matters here is only that this SEARCHING fixture is never among whatever
    // the sweep does act on.
    const expectedChecked = (
      await admin()
        .firestore.collection(TEST_COLLECTION)
        .where('status', '==', 'REQUESTED')
        .where('createdAt', '<=', Timestamp.fromMillis(Date.now() - 5 * 60_000))
        .get()
    ).size;

    const outcome = await retryStuckRequestedTrips(deps);

    expect((await ref.get()).get('status')).toBe('SEARCHING');
    expect(outcome.checked).toBe(expectedChecked);
  });
});

describe('retryDelayedJourneys', () => {
  async function matchingJourney(prefix: string, delay: unknown): Promise<string> {
    counter += 1;
    const ref = admin().firestore.collection('driverJourneys').doc();
    await ref.set({
      driverId: `${prefix}-driver-${counter}`,
      status: 'MATCHING',
      delay,
    });
    return ref.id;
  }

  it('attempts a MATCHING journey still flagged delayed (and reoptimizeDelayedJourney itself skips it, having no reorderable plan)', async () => {
    const journeyId = await matchingJourney('delayed', { extraMinutes: 12 });

    const outcome = await retryDelayedJourneys({
      firestore: admin().firestore,
      provider: NOWHERE_PROVIDER,
      optimizationService: { baseUrl: 'http://127.0.0.1:1' },
      push: { sendPush: () => Promise.resolve({ status: 'sent' }) },
    });

    expect(outcome.checked).toBeGreaterThanOrEqual(1);
    // Never reoptimized here: this fixture has no journeyPlans document at all, so
    // reoptimizeDelayedJourney's own precondition check returns 'skipped' before calling out to
    // anything - proving the sweep found and attempted it is the point, not re-proving
    // reoptimizeDelayedJourney's own full success path (routeModification.int.test.ts already does).
    expect((await admin().firestore.doc(`driverJourneys/${journeyId}`).get()).get('delay')).toEqual(
      { extraMinutes: 12 },
    );
  });

  it('excludes a MATCHING journey with no delay flag from its own count', async () => {
    // The whole suite shares one long-lived Firestore (fileParallelism: false), so other files may
    // leave their own MATCHING/delayed journeys behind - `checked` is derived the same way the sweep
    // itself derives it (status MATCHING, delay not null), independently, right before adding one
    // more of each kind, rather than assumed to start at zero.
    const before = (
      await admin().firestore.collection('driverJourneys').where('status', '==', 'MATCHING').get()
    ).docs.filter((doc) => doc.get('delay') != null).length;

    await matchingJourney('no-delay', null);
    await matchingJourney('newly-delayed', { extraMinutes: 5 });

    const outcome = await retryDelayedJourneys({
      firestore: admin().firestore,
      provider: NOWHERE_PROVIDER,
      optimizationService: { baseUrl: 'http://127.0.0.1:1' },
      push: { sendPush: () => Promise.resolve({ status: 'sent' }) },
    });

    expect(outcome.checked).toBe(before + 1);
  });
});

describe('retryStaleAuthorizedHolds', () => {
  async function releasedTrip(prefix: string, status: string, ageMs: number): Promise<string> {
    counter += 1;
    const ref = admin().firestore.collection('tripRequests').doc();
    await ref.set({
      passengerId: `${prefix}-passenger-${counter}`,
      status,
      paymentIntentId: `pi_${prefix}_${counter}`,
      paymentStatus: 'AUTHORIZED',
      updatedAt: Timestamp.fromMillis(Date.now() - ageMs),
    });
    return ref.id;
  }

  it('voids a stale hold released more than the threshold ago', async () => {
    const tripId = await releasedTrip('stale', 'SEARCHING', 15 * 60_000);

    const outcome = await retryStaleAuthorizedHolds({
      firestore: admin().firestore,
      stripe: fakeStripe(),
    });

    expect(outcome.checked).toBeGreaterThanOrEqual(1);
    expect(outcome.voided).toBeGreaterThanOrEqual(1);
    expect((await admin().firestore.doc(`tripRequests/${tripId}`).get()).get('paymentStatus')).toBe(
      null,
    );
  });

  it('leaves a hold released less than the threshold ago alone', async () => {
    const tripId = await releasedTrip('recent', 'CANCELLED', 1_000);

    await retryStaleAuthorizedHolds({ firestore: admin().firestore, stripe: fakeStripe() });

    expect((await admin().firestore.doc(`tripRequests/${tripId}`).get()).get('paymentStatus')).toBe(
      'AUTHORIZED',
    );
  });

  it('leaves an unreleased AUTHORIZED trip (still matched) alone', async () => {
    const tripId = await releasedTrip('matched', 'PICKUP_ASSIGNED', 15 * 60_000);

    await retryStaleAuthorizedHolds({ firestore: admin().firestore, stripe: fakeStripe() });

    expect((await admin().firestore.doc(`tripRequests/${tripId}`).get()).get('paymentStatus')).toBe(
      'AUTHORIZED',
    );
  });
});
