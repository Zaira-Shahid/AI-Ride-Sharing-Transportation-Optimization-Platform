import { Timestamp } from 'firebase-admin/firestore';
import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import { getTripDetail, listActiveTrips, listTripHistory } from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail, type Client } from './support';

// Module 11.4 (admin dashboard: trip monitoring). tripRequests has no staff read rule at all
// (docs/security.md: "staff access will come through audited functions... not a blanket read rule"),
// so listActiveTrips/listTripHistory/getTripDetail (functions/src/tripMonitoring.ts) are the only path
// staff have to this data. This file covers: who may call each, that list rows carry no exact place,
// that getTripDetail's own audit entry names the trip but never a place, and pagination.

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

const tripRequest = (overrides: Record<string, unknown> = {}) => ({
  origin: HOME,
  destination: OFFICE,
  departure: { kind: 'NOW' },
  arriveBy: null,
  preferences: BALANCED,
  ...overrides,
});

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

async function staff(role: string, prefix: string, verified = true) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await admin().auth.setCustomUserClaims(uid, { role });
  if (verified) await verifyEmail(user, email);
  else await user.getIdToken(true);
  return { client, uid, email };
}

async function activeTrip(prefix: string) {
  const p = await passenger(prefix);
  const created = await call(p.client, 'createTripRequest', tripRequest());
  const tripId = (created.data as { tripId: string }).tripId;
  return { ...p, tripId };
}

async function cancelledTrip(prefix: string) {
  const trip = await activeTrip(prefix);
  await call(trip.client, 'cancelTripRequest', { tripId: trip.tripId });
  return trip;
}

const auditOf = async (entity: string, action: string) =>
  (
    await admin()
      .firestore.collection('auditLogs')
      .where('entity', '==', entity)
      .where('action', '==', action)
      .get()
  ).docs;

describe('listActiveTrips (functions + firestore + auth emulators)', () => {
  it('lists an open trip, with no exact place, and not a cancelled one', async () => {
    const reviewer = await staff('SUPPORT', 'monitor-active-reviewer');
    const open = await activeTrip('monitor-active-open');
    const cancelled = await cancelledTrip('monitor-active-cancelled');

    const rows = await listActiveTrips(reviewer.client);
    const openRow = rows.find((row) => row.tripId === open.tripId);
    // status is REQUESTED or already SEARCHING by the time this reads it - matchTripRequestOnCreate
    // fires as soon as the request is created, and its own timing is not this test's concern.
    // passengerName is the passenger's own first name only (Module 3.7's own snapshot field).
    expect(openRow).toMatchObject({ passengerName: 'Test' });
    expect(['REQUESTED', 'SEARCHING']).toContain(openRow?.status);
    expect(openRow).not.toHaveProperty('origin');
    expect(openRow).not.toHaveProperty('destination');
    expect(rows.some((row) => row.tripId === cancelled.tripId)).toBe(false);
  });

  it('refuses everyone but a verified staff account', async () => {
    await expect(call(createClient(), 'listActiveTrips')).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });
    const refused = [
      await staff('SUPPORT', 'monitor-active-unverified', false),
      await passenger('monitor-active-passenger'),
    ];
    for (const caller of refused) {
      await expect(call(caller.client, 'listActiveTrips')).rejects.toMatchObject({
        code: 'functions/permission-denied',
      });
    }
  });

  it('lets every staff role view - this is read-only monitoring, not a decision', async () => {
    for (const role of ['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN']) {
      const reviewer = await staff(role, `monitor-active-${role.toLowerCase()}`);
      await expect(listActiveTrips(reviewer.client)).resolves.toBeInstanceOf(Array);
    }
  });
});

describe('listTripHistory (functions + firestore + auth emulators)', () => {
  it('lists a cancelled trip, with no exact place, and not an open one', async () => {
    const reviewer = await staff('ADMIN', 'monitor-history-reviewer');
    const cancelled = await cancelledTrip('monitor-history-cancelled');
    const open = await activeTrip('monitor-history-open');

    const result = await listTripHistory(reviewer.client);
    const row = result.rows.find((r) => r.tripId === cancelled.tripId);
    expect(row).toMatchObject({ status: 'CANCELLED' });
    expect(row).not.toHaveProperty('origin');
    expect(result.rows.some((r) => r.tripId === open.tripId)).toBe(false);
  });

  it('pages through more results than one page holds', async () => {
    const reviewer = await staff('ADMIN', 'monitor-history-paging-reviewer');
    // Seeded directly (bypassing the real creation flow) - what's under test is this module's own
    // pagination/cursor logic over tripRequests documents, not trip creation itself. Each gets a
    // distinct createdAt (a millisecond apart, oldest last) so the newest-first order is deterministic.
    const { firestore } = admin();
    const nowMs = Date.now();
    for (let index = 0; index < 30; index += 1) {
      await firestore
        .collection('tripRequests')
        .doc()
        .set({
          passengerId: 'seed-passenger',
          passengerName: 'Seed Passenger',
          status: 'CANCELLED',
          createdAt: Timestamp.fromMillis(nowMs - index),
        });
    }

    const first = await listTripHistory(reviewer.client);
    expect(first.rows).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();

    const second = await listTripHistory(reviewer.client, first.nextCursor);
    expect(second.rows.length).toBeGreaterThanOrEqual(5);
    const firstIds = new Set(first.rows.map((row) => row.tripId));
    for (const row of second.rows) expect(firstIds.has(row.tripId)).toBe(false);
  });

  it('pages newest first without skipping an entry, even within one millisecond', async () => {
    const reviewer = await staff('ADMIN', 'monitor-history-same-ms-reviewer');
    // 30 trips inside the SAME millisecond, a microsecond apart: a cursor cut to milliseconds would
    // lose entries here (docs/security.md's own note on this). A fixed FUTURE second, not "now": the
    // whole suite shares one long-lived Firestore, and another file's own real trip (a real
    // FieldValue.serverTimestamp()) could otherwise land a moment newer than "now" was when this test
    // read it, sorting ahead of some of these 30 and pushing them past the two pages this test reads.
    // Nothing can ever be newer than a fixed point 10 years out.
    const { firestore } = admin();
    const millis = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
    const ids: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const ref = firestore.collection('tripRequests').doc();
      ids.push(ref.id);
      await ref.set({
        passengerId: 'seed-passenger-same-ms',
        passengerName: 'Seed Passenger',
        status: 'CANCELLED',
        createdAt: new Timestamp(Math.floor(millis / 1000), 100_000_000 + index * 1000),
      });
    }
    // Index increases with nanoseconds, so the last-created (highest nanoseconds) sorts first.
    const created = [...ids].reverse();

    const first = await listTripHistory(reviewer.client);
    const second = await listTripHistory(reviewer.client, first.nextCursor);
    const listed = [...first.rows, ...second.rows]
      .map((row) => row.tripId)
      .filter((tripId) => created.includes(tripId));

    expect(listed).toEqual(created);
  });
});

describe('getTripDetail (functions + firestore + auth emulators)', () => {
  it('returns the exact places and audits a view naming the trip but not the place', async () => {
    const reviewer = await staff('SUPPORT', 'monitor-detail-reviewer');
    const trip = await activeTrip('monitor-detail-target');

    const detail = await getTripDetail(reviewer.client, trip.tripId);
    expect(detail.origin).toMatchObject({ formattedAddress: HOME.formattedAddress });
    expect(detail.destination).toMatchObject({ formattedAddress: OFFICE.formattedAddress });

    const entries = await auditOf(`tripRequests/${trip.tripId}`, 'TRIP_VIEWED_BY_STAFF');
    expect(entries).toHaveLength(1);
    const entry = entries[0]?.data();
    expect(entry).toMatchObject({ actor: reviewer.uid });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(HOME.formattedAddress);
    expect(serialized).not.toContain(OFFICE.formattedAddress);
  });

  it('reports null places, not 0,0, once the retention sweep has cleared them', async () => {
    const reviewer = await staff('SUPPORT', 'monitor-detail-cleared-reviewer');
    const trip = await cancelledTrip('monitor-detail-cleared');
    await admin().firestore.doc(`tripRequests/${trip.tripId}`).update({
      origin: null,
      destination: null,
      driverLocation: null,
      placesCleared: true,
    });

    const detail = await getTripDetail(reviewer.client, trip.tripId);
    expect(detail.origin).toBeNull();
    expect(detail.destination).toBeNull();
    expect(detail).toMatchObject({ tripId: trip.tripId, status: 'CANCELLED' });
  });

  it('reports a trip that does not exist', async () => {
    const reviewer = await staff('ADMIN', 'monitor-detail-missing');
    // Only the code is asserted here, matching every other not-found test in this codebase
    // (verification.int.test.ts, userManagement.int.test.ts) - the client SDK appends an HTTP-status
    // suffix ("... [404]") to a not-found HttpsError's message that other codes don't get.
    await expect(getTripDetail(reviewer.client, 'nobody-here')).rejects.toMatchObject({
      code: 'functions/not-found',
    });
  });

  it('refuses everyone but a verified staff account', async () => {
    const trip = await activeTrip('monitor-detail-refuse-target');
    await expect(getTripDetail(createClient(), trip.tripId)).rejects.toMatchObject({
      code: 'functions/unauthenticated',
    });
    const passengerCaller = await passenger('monitor-detail-refuse-passenger');
    await expect(getTripDetail(passengerCaller.client, trip.tripId)).rejects.toMatchObject({
      message: 'You are not allowed to view trips.',
    });
  });
});
