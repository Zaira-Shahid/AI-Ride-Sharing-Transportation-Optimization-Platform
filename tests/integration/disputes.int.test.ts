import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import { getTripDetail, listDisputedTrips, markDisputeReviewed } from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

// Module 11.7 (admin dashboard: disputes). listDisputedTrips/markDisputeReviewed
// (functions/src/disputes.ts) are new; getTripDetail is 11.4's own already-tested audited read reused
// unchanged. Disputed trips are seeded here via a direct admin write (paymentStatus: 'DISPUTED') -
// what's under test is this module's own read/mark logic, not how a trip becomes disputed (module
// 9.9's webhook already has its own dedicated tests for that).

const OFFICE = {
  latitude: 51.5049,
  longitude: -0.0195,
  formattedAddress: '1 Canada Square, London E14 5AB, UK',
  placeId: 'place-office',
};
const HOME = {
  latitude: 51.4545,
  longitude: -2.5879,
  formattedAddress: 'Temple Meads, Bristol BS1 6QS, UK',
  placeId: 'place-home',
};
const BALANCED = {
  flexibilityLevel: 'BALANCED',
  maxWalkingDistance: 500,
  maxExtraTime: 10,
  maxDetourDistance: 3,
  allowSharedRide: true,
  allowRouteChange: true,
};

const call = (client: Client, name: string, data?: unknown) =>
  httpsCallable(client.functions, name)(data);

async function passenger(prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(
    client.functions,
    'completeRegistration',
  )({
    role: 'PASSENGER',
    name: 'Test Person',
  });
  await verifyEmail(user, email);
  return { client, uid, email };
}

async function staff(prefix: string, role = 'ADMIN') {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await admin().auth.setCustomUserClaims(uid, { role });
  await verifyEmail(user, email);
  return { client, uid };
}

/** A real trip request, marked DISPUTED directly (see the file's own comment on why). */
async function disputedTrip(prefix: string) {
  const p = await passenger(prefix);
  const created = await call(p.client, 'createTripRequest', {
    origin: HOME,
    destination: OFFICE,
    departure: { kind: 'NOW' },
    arriveBy: null,
    preferences: BALANCED,
  });
  const tripId = (created.data as { tripId: string }).tripId;
  await admin()
    .firestore.doc(`tripRequests/${tripId}`)
    .update({ paymentStatus: 'DISPUTED', finalFareMinorUnits: 1250 });
  return { ...p, tripId };
}

const auditOf = async (entity: string, action: string) =>
  (
    await admin()
      .firestore.collection('auditLogs')
      .where('entity', '==', entity)
      .where('action', '==', action)
      .get()
  ).docs;

describe('listDisputedTrips (functions + firestore + auth emulators)', () => {
  it('lists a disputed trip, not yet reviewed, with no exact place', async () => {
    const reviewer = await staff('dispute-list-reviewer');
    const trip = await disputedTrip('dispute-list-target');

    const rows = await listDisputedTrips(reviewer.client);
    const row = rows.find((r) => r.tripId === trip.tripId);
    expect(row).toMatchObject({
      passengerName: 'Test',
      finalFareMinorUnits: 1250,
      disputeReviewed: false,
    });
    expect(row).not.toHaveProperty('origin');
    expect(row).not.toHaveProperty('destination');
  });

  it('does not list a trip whose payment was never disputed', async () => {
    const reviewer = await staff('dispute-list-clean-reviewer');
    const p = await passenger('dispute-list-clean-target');
    const created = await call(p.client, 'createTripRequest', {
      origin: HOME,
      destination: OFFICE,
      departure: { kind: 'NOW' },
      arriveBy: null,
      preferences: BALANCED,
    });
    const tripId = (created.data as { tripId: string }).tripId;

    const rows = await listDisputedTrips(reviewer.client);
    expect(rows.some((r) => r.tripId === tripId)).toBe(false);
  });

  it('refuses everyone but a verified staff account', async () => {
    await expect(call(createClient(), 'listDisputedTrips')).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });
    const passengerCaller = await passenger('dispute-list-refuse-passenger');
    await expect(listDisputedTrips(passengerCaller.client)).rejects.toMatchObject({
      message: 'You are not allowed to view disputes.',
    });
  });
});

describe('markDisputeReviewed (functions + firestore + auth emulators)', () => {
  it('marks a disputed trip reviewed, and audits it without naming a place', async () => {
    const reviewer = await staff('dispute-mark-reviewer');
    const trip = await disputedTrip('dispute-mark-target');

    expect(await markDisputeReviewed(reviewer.client, trip.tripId)).toBe('reviewed');
    const rows = await listDisputedTrips(reviewer.client);
    expect(rows.find((r) => r.tripId === trip.tripId)?.disputeReviewed).toBe(true);

    const entries = await auditOf(`tripRequests/${trip.tripId}`, 'DISPUTE_REVIEWED');
    expect(entries).toHaveLength(1);
    const entry = entries[0]?.data();
    expect(entry).toMatchObject({ actor: reviewer.uid });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(HOME.formattedAddress);
    expect(serialized).not.toContain(OFFICE.formattedAddress);
  });

  it('is unchanged on a repeat call, and never re-audits', async () => {
    const reviewer = await staff('dispute-repeat-reviewer');
    const trip = await disputedTrip('dispute-repeat-target');

    expect(await markDisputeReviewed(reviewer.client, trip.tripId)).toBe('reviewed');
    expect(await markDisputeReviewed(reviewer.client, trip.tripId)).toBe('unchanged');
    expect(await auditOf(`tripRequests/${trip.tripId}`, 'DISPUTE_REVIEWED')).toHaveLength(1);
  });

  it('refuses a trip whose payment is not currently disputed', async () => {
    const reviewer = await staff('dispute-notdisputed-reviewer');
    const p = await passenger('dispute-notdisputed-target');
    const created = await call(p.client, 'createTripRequest', {
      origin: HOME,
      destination: OFFICE,
      departure: { kind: 'NOW' },
      arriveBy: null,
      preferences: BALANCED,
    });
    const tripId = (created.data as { tripId: string }).tripId;

    await expect(markDisputeReviewed(reviewer.client, tripId)).rejects.toMatchObject({
      code: 'functions/failed-precondition',
    });
  });

  it('reports a trip that does not exist', async () => {
    const reviewer = await staff('dispute-missing-reviewer');
    await expect(markDisputeReviewed(reviewer.client, 'nobody-here')).rejects.toMatchObject({
      code: 'functions/not-found',
    });
  });

  it('lets any staff role mark reviewed - a work-queue marker, not a financial decision', async () => {
    for (const role of ['SUPPORT', 'OPERATIONS']) {
      const reviewer = await staff(`dispute-anyrole-${role.toLowerCase()}`, role);
      const trip = await disputedTrip(`dispute-anyrole-target-${role.toLowerCase()}`);
      expect(await markDisputeReviewed(reviewer.client, trip.tripId)).toBe('reviewed');
    }
  });

  it('refuses everyone but a verified staff account', async () => {
    const trip = await disputedTrip('dispute-mark-refuse-target');
    await expect(markDisputeReviewed(createClient(), trip.tripId)).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });
    const passengerCaller = await passenger('dispute-mark-refuse-passenger');
    await expect(markDisputeReviewed(passengerCaller.client, trip.tripId)).rejects.toMatchObject({
      message: 'You are not allowed to view disputes.',
    });
  });
});

describe('getTripDetail on a disputed trip (reused from module 11.4)', () => {
  it('reveals the exact places, still audited', async () => {
    const reviewer = await staff('dispute-detail-reviewer');
    const trip = await disputedTrip('dispute-detail-target');

    const detail = await getTripDetail(reviewer.client, trip.tripId);
    expect(detail.origin?.formattedAddress).toBe(HOME.formattedAddress);
    expect(detail.destination?.formattedAddress).toBe(OFFICE.formattedAddress);
  });
});
