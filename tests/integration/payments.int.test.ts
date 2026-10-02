import { httpsCallable } from 'firebase/functions';
import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { getPaymentsSummary, listPayments } from '../../packages/firebase/src';
import { refundPaymentAsStaff } from '../../functions/src/payments';
import type { StripeProvider } from '../../functions/src/stripeProvider';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

// Module 11.10 (admin dashboard: payments). listPayments/getPaymentsSummary are new, tested through
// the real callable (real staff accounts, real role gate) - neither touches Stripe. refundPayment
// (functions/src/payments.ts's own refundPaymentAsStaff) is tested directly with a fake Stripe and a
// hand-built StaffCaller, the same "no real Stripe key in this environment" approach paymentCapture.
// int.test.ts/paymentRefund.int.test.ts already take for anything that calls Stripe - the real onCall
// wrapper (index.ts) would fail with failed-precondition here regardless of role, since
// STRIPE_SECRET_KEY is never set for the emulators. refundTripPayment's own logic (module 9.7) already
// has its own dedicated tests; what's under test here is only payments.ts's own wiring: the reviewer
// gate, the reason requirement, and the real actor/reason reaching the audit entry.

function fakeStripe(overrides: Partial<StripeProvider> = {}): StripeProvider {
  return {
    ping: async () => true,
    createCustomer: async () => 'cus_fake',
    authorizePayment: async () => ({ status: 'authorized', paymentIntentId: 'pi_fake' }),
    capturePayment: async () => ({ status: 'captured' }),
    voidPayment: async () => ({ status: 'voided' }),
    refundPayment: async () => ({ status: 'refunded' }),
    deleteCustomer: async () => ({ status: 'deleted' }),
    verifyWebhookEvent: () => ({ status: 'invalid' }),
    ...overrides,
  };
}

let counter = 0;

/** A trip request seeded directly with a given payment status - what's under test is this module's
 * own read/summary/refund wiring, not how a trip actually reaches CAPTURED (paymentCapture.int.test.ts
 * already covers that). */
async function seededTrip(
  prefix: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  counter += 1;
  const ref = admin().firestore.collection('tripRequests').doc();
  await ref.set({
    passengerId: `${prefix}-passenger-${counter}`,
    passengerName: 'Test Passenger',
    driverName: 'Test Driver',
    status: 'COMPLETED',
    paymentStatus: 'CAPTURED',
    paymentIntentId: `pi_${prefix}_${counter}`,
    finalFareMinorUnits: 1000,
    platformFeeMinorUnits: 200,
    refundedAmountMinorUnits: null,
    createdAt: Timestamp.now(),
    ...overrides,
  });
  return ref.id;
}

async function staff(prefix: string, role = 'ADMIN') {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await admin().auth.setCustomUserClaims(uid, { role });
  await verifyEmail(user, email);
  return { client, uid };
}

async function passenger(prefix: string): Promise<Client> {
  const client = createClient();
  const { user, email } = await signUp(client, prefix);
  await httpsCallable(
    client.functions,
    'completeRegistration',
  )({ role: 'PASSENGER', name: 'Test Person' });
  await verifyEmail(user, email);
  return client;
}

const auditOf = async (tripId: string, action: string) =>
  (
    await admin()
      .firestore.collection('auditLogs')
      .where('entity', '==', `tripRequests/${tripId}`)
      .where('action', '==', action)
      .get()
  ).docs;

describe('listPayments/getPaymentsSummary (functions + firestore + auth emulators)', () => {
  it('lists trips by payment status, newest first, and excludes DISPUTED/PENDING by default', async () => {
    const reviewer = await staff('pay-list-reviewer');
    const captured = await seededTrip('pay-list-captured', { paymentStatus: 'CAPTURED' });
    const failed = await seededTrip('pay-list-failed', { paymentStatus: 'FAILED' });
    const disputed = await seededTrip('pay-list-disputed', { paymentStatus: 'DISPUTED' });
    const pending = await seededTrip('pay-list-pending', { paymentStatus: 'PENDING' });

    const result = await listPayments(reviewer.client);
    const ids = result.rows.map((r) => r.tripId);
    expect(ids).toContain(captured);
    expect(ids).toContain(failed);
    expect(ids).not.toContain(disputed);
    expect(ids).not.toContain(pending);
    const row = result.rows.find((r) => r.tripId === captured);
    expect(row).not.toHaveProperty('origin');
  });

  it('filters to exactly one payment status when asked', async () => {
    const reviewer = await staff('pay-filter-reviewer');
    const failed = await seededTrip('pay-filter-failed', { paymentStatus: 'FAILED' });
    const captured = await seededTrip('pay-filter-captured', { paymentStatus: 'CAPTURED' });

    const result = await listPayments(reviewer.client, { paymentStatus: 'FAILED' });
    const ids = result.rows.map((r) => r.tripId);
    expect(ids).toContain(failed);
    expect(ids).not.toContain(captured);
  });

  it('lets any staff role view the list and the summary, and refuses everyone else', async () => {
    const action = `pay-role-${Date.now()}`;
    await seededTrip(action, { paymentStatus: 'CAPTURED' });

    for (const role of ['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN']) {
      const caller = await staff(`pay-role-${role.toLowerCase()}`, role);
      await expect(listPayments(caller.client)).resolves.toBeDefined();
      await expect(getPaymentsSummary(caller.client)).resolves.toBeDefined();
    }

    const passengerClient = await passenger('pay-role-passenger');
    await expect(listPayments(passengerClient)).rejects.toMatchObject({
      message: 'You are not allowed to view payments.',
    });
    await expect(httpsCallable(createClient().functions, 'listPayments')()).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });
  });

  it('sums real amounts across captured/refunded trips, and platform fee unaffected by a refund', async () => {
    const reviewer = await staff('pay-summary-reviewer');
    await seededTrip('pay-summary-captured', {
      paymentStatus: 'CAPTURED',
      finalFareMinorUnits: 1_000,
      platformFeeMinorUnits: 200,
    });
    await seededTrip('pay-summary-refunded', {
      paymentStatus: 'REFUNDED',
      finalFareMinorUnits: 800,
      platformFeeMinorUnits: 160,
      refundedAmountMinorUnits: 800,
    });
    await seededTrip('pay-summary-partial', {
      paymentStatus: 'PARTIALLY_REFUNDED',
      finalFareMinorUnits: 500,
      platformFeeMinorUnits: 100,
      refundedAmountMinorUnits: 200,
    });
    await seededTrip('pay-summary-failed', { paymentStatus: 'FAILED', finalFareMinorUnits: 999 });
    await seededTrip('pay-summary-disputed', {
      paymentStatus: 'DISPUTED',
      finalFareMinorUnits: 999,
    });

    const summary = await getPaymentsSummary(reviewer.client);
    expect(summary.totalCapturedMinorUnits).toBeGreaterThanOrEqual(1_000 + 800 + 500);
    expect(summary.totalPlatformFeeMinorUnits).toBeGreaterThanOrEqual(200 + 160 + 100);
    expect(summary.totalRefundedMinorUnits).toBeGreaterThanOrEqual(800 + 200);
  });
});

describe('refundPaymentAsStaff (functions + firestore emulator, fake Stripe)', () => {
  const reviewerCaller = (uid: string) => ({ uid, role: 'ADMIN', emailVerified: true });

  it('refuses SUPPORT/OPERATIONS, requires a reason, and issues a full refund by default', async () => {
    const tripId = await seededTrip('pay-refund-role');
    const nonReviewer = { uid: 'someone', role: 'SUPPORT', emailVerified: true };
    await expect(
      refundPaymentAsStaff({ firestore: admin().firestore, stripe: fakeStripe() }, nonReviewer, {
        tripId,
        reason: 'Customer complaint',
      }),
    ).rejects.toMatchObject({ message: 'You are not allowed to issue a refund.' });

    await expect(
      refundPaymentAsStaff(
        { firestore: admin().firestore, stripe: fakeStripe() },
        reviewerCaller('reviewer-1'),
        { tripId },
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });

    const stripe = fakeStripe({
      refundPayment: async (params) => {
        expect(params.amountMinorUnits).toBe(1_000);
        expect(typeof params.paymentIntentId).toBe('string');
        return { status: 'refunded' };
      },
    });
    const result = await refundPaymentAsStaff(
      { firestore: admin().firestore, stripe },
      reviewerCaller('reviewer-1'),
      { tripId, reason: 'Customer complaint' },
    );
    expect(result).toEqual({ status: 'refunded' });

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.paymentStatus).toBe('REFUNDED');
    expect(trip?.refundedAmountMinorUnits).toBe(1_000);

    const entries = await auditOf(tripId, 'TRIP_PAYMENT_REFUNDED');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data()).toMatchObject({
      actor: 'reviewer-1',
      reason: 'Full refund issued: Customer complaint',
    });
  });

  it('issues a partial refund for the given amount', async () => {
    const tripId = await seededTrip('pay-refund-partial');
    const stripe = fakeStripe({ refundPayment: async () => ({ status: 'refunded' }) });

    const result = await refundPaymentAsStaff(
      { firestore: admin().firestore, stripe },
      reviewerCaller('reviewer-2'),
      { tripId, amountMinorUnits: 300, reason: 'Partial goodwill credit' },
    );
    expect(result).toEqual({ status: 'refunded' });

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.paymentStatus).toBe('PARTIALLY_REFUNDED');
    expect(trip?.refundedAmountMinorUnits).toBe(300);

    const entries = await auditOf(tripId, 'TRIP_PAYMENT_REFUNDED');
    expect(entries[0]?.data()).toMatchObject({
      reason: 'Partial refund issued: Partial goodwill credit',
    });
  });

  it('audits a failed refund attempt with the real actor and reason, leaving the trip CAPTURED', async () => {
    const tripId = await seededTrip('pay-refund-failed');
    const stripe = fakeStripe({ refundPayment: async () => ({ status: 'failed' }) });

    const result = await refundPaymentAsStaff(
      { firestore: admin().firestore, stripe },
      reviewerCaller('reviewer-3'),
      { tripId, reason: 'Trying anyway' },
    );
    expect(result).toEqual({ status: 'failed' });

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.paymentStatus).toBe('CAPTURED');

    const entries = await auditOf(tripId, 'TRIP_PAYMENT_REFUND_FAILED');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data()).toMatchObject({
      actor: 'reviewer-3',
      reason: 'The captured payment could not be refunded: Trying anyway',
    });
  });

  it('rejects an invalid amount or a trip that is not CAPTURED before ever calling Stripe', async () => {
    const tripId = await seededTrip('pay-refund-invalid');
    let called = false;
    const stripe = fakeStripe({
      refundPayment: async () => {
        called = true;
        return { status: 'refunded' };
      },
    });

    await expect(
      refundPaymentAsStaff({ firestore: admin().firestore, stripe }, reviewerCaller('reviewer-4'), {
        tripId,
        amountMinorUnits: 5_000,
        reason: 'Too much',
      }),
    ).resolves.toEqual({ status: 'skipped' });
    expect(called).toBe(false);

    const disputedTripId = await seededTrip('pay-refund-not-captured', {
      paymentStatus: 'DISPUTED',
    });
    await expect(
      refundPaymentAsStaff({ firestore: admin().firestore, stripe }, reviewerCaller('reviewer-4'), {
        tripId: disputedTripId,
        reason: 'Wrong state',
      }),
    ).resolves.toEqual({ status: 'skipped' });
    expect(called).toBe(false);
  });
});
