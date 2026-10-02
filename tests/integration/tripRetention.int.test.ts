import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import {
  clearExpiredJourneyPlaces,
  clearExpiredTripPlaces,
  JOURNEY_PLACES_RETENTION_DAYS,
  TRIP_PLACES_RETENTION_DAYS,
} from '../../functions/src/tripRetention';
import { admin } from './support';

// Phase 14 (Privacy compliance): the 30-day retention rule from docs/security.md. A dedicated
// collection (never 'tripRequests'): a real tripRequests document anywhere in this shared-emulator
// suite fires the real matchTripRequestOnCreate trigger, and a run over the real collection would
// also pick up leftover ended trips from other files.

const TEST_COLLECTION = 'tripRequestsUnderTestRetention';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOME = { latitude: 51.5, longitude: -0.1, formattedAddress: '1 Home Street, London' };
const OFFICE = { latitude: 51.6, longitude: -0.2, formattedAddress: '2 Office Road, London' };
const deps = { firestore: admin().firestore, collection: TEST_COLLECTION };

async function trip(fields: Record<string, unknown>): Promise<string> {
  const ref = admin().firestore.collection(TEST_COLLECTION).doc();
  const createdAt = Timestamp.fromMillis(Date.now() - 100 * DAY_MS);
  await ref.set({
    passengerId: 'retention-passenger',
    status: 'COMPLETED',
    origin: HOME,
    destination: OFFICE,
    driverLocation: { latitude: 51.55, longitude: -0.15, accuracy: 5 },
    finalFareMinorUnits: 1250,
    paymentStatus: 'CAPTURED',
    placesCleared: false,
    createdAt,
    updatedAt: createdAt,
    ...fields,
  });
  return ref.id;
}

const endedDaysAgo = (days: number) => Timestamp.fromMillis(Date.now() - days * DAY_MS);

async function read(id: string) {
  return (await admin().firestore.collection(TEST_COLLECTION).doc(id).get()).data() ?? {};
}

async function auditsFor(id: string) {
  const snapshot = await admin()
    .firestore.collection('auditLogs')
    .where('entity', '==', `${TEST_COLLECTION}/${id}`)
    .get();
  return snapshot.docs.map((doc) => doc.data());
}

describe('clearExpiredTripPlaces', () => {
  it('uses the 30 day policy the docs record', () => {
    expect(TRIP_PLACES_RETENTION_DAYS).toBe(30);
  });

  it('clears the places and the driver position of a completed request older than 30 days', async () => {
    const id = await trip({ endedAt: endedDaysAgo(31) });
    const outcome = await clearExpiredTripPlaces(deps);
    expect(outcome.cleared).toBeGreaterThanOrEqual(1);

    const data = await read(id);
    expect(data.origin).toBeNull();
    expect(data.destination).toBeNull();
    expect(data.driverLocation).toBeNull();
    expect(data.placesCleared).toBe(true);
  });

  it('clears a cancelled request the same way', async () => {
    const id = await trip({ status: 'CANCELLED', endedAt: endedDaysAgo(45), paymentStatus: null });
    await clearExpiredTripPlaces(deps);
    const data = await read(id);
    expect(data.origin).toBeNull();
    expect(data.placesCleared).toBe(true);
  });

  it('keeps everything fares, payments and disputes still need', async () => {
    const id = await trip({ endedAt: endedDaysAgo(31), matchedDriverId: 'driver-x' });
    await clearExpiredTripPlaces(deps);
    const data = await read(id);
    expect(data).toMatchObject({
      passengerId: 'retention-passenger',
      status: 'COMPLETED',
      finalFareMinorUnits: 1250,
      paymentStatus: 'CAPTURED',
      matchedDriverId: 'driver-x',
    });
  });

  it('leaves a request that ended less than 30 days ago alone', async () => {
    const id = await trip({ endedAt: endedDaysAgo(29) });
    await clearExpiredTripPlaces(deps);
    const data = await read(id);
    expect(data.origin).toMatchObject({ formattedAddress: HOME.formattedAddress });
    expect(data.destination).toMatchObject({ formattedAddress: OFFICE.formattedAddress });
    expect(data.driverLocation).not.toBeNull();
    expect(data.placesCleared).toBe(false);
  });

  it('never touches a request that has not ended', async () => {
    const id = await trip({ status: 'SEARCHING', endedAt: null, paymentStatus: null });
    await clearExpiredTripPlaces(deps);
    expect((await read(id)).origin).toMatchObject({ formattedAddress: HOME.formattedAddress });
  });

  it('never touches an old request that has no endedAt (it ended before this existed)', async () => {
    const id = await trip({});
    await clearExpiredTripPlaces(deps);
    expect((await read(id)).origin).toMatchObject({ formattedAddress: HOME.formattedAddress });
  });

  it('refuses to clear a request whose status is not ended, even with an old endedAt', async () => {
    const id = await trip({ status: 'IN_TRANSIT', endedAt: endedDaysAgo(60) });
    await clearExpiredTripPlaces(deps);
    const data = await read(id);
    expect(data.origin).toMatchObject({ formattedAddress: HOME.formattedAddress });
    expect(data.placesCleared).toBe(false);
  });

  it('audits each clearing without naming any place', async () => {
    const id = await trip({ endedAt: endedDaysAgo(31) });
    await clearExpiredTripPlaces(deps);
    const entries = await auditsFor(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: 'system', action: 'TRIP_PLACES_CLEARED' });
    const text = JSON.stringify(entries[0]);
    expect(text).not.toContain(HOME.formattedAddress);
    expect(text).not.toContain(OFFICE.formattedAddress);
    expect(text).not.toContain('51.5');
  });

  it('clears a request once: a second run does nothing and writes no second audit entry', async () => {
    const id = await trip({ endedAt: endedDaysAgo(31) });
    await clearExpiredTripPlaces(deps);
    await clearExpiredTripPlaces(deps);
    expect(await auditsFor(id)).toHaveLength(1);
  });
});

// The same rule for a driver's journey: its own collection for the same reason as above (a real
// driverJourneys document would be seen by every other file's global batch run).
const JOURNEY_COLLECTION = 'driverJourneysUnderTestRetention';
const journeyDeps = { firestore: admin().firestore, collection: JOURNEY_COLLECTION };

async function journey(fields: Record<string, unknown>): Promise<string> {
  const ref = admin().firestore.collection(JOURNEY_COLLECTION).doc();
  const createdAt = Timestamp.fromMillis(Date.now() - 100 * DAY_MS);
  await ref.set({
    driverId: 'retention-driver',
    vehicleId: 'retention-driver',
    status: 'COMPLETED',
    origin: HOME,
    destination: OFFICE,
    currentLocation: { latitude: 51.55, longitude: -0.15 },
    matchedTripRequestIds: ['a', 'b'],
    placesCleared: false,
    createdAt,
    updatedAt: createdAt,
    ...fields,
  });
  return ref.id;
}

async function readJourney(id: string) {
  return (await admin().firestore.collection(JOURNEY_COLLECTION).doc(id).get()).data() ?? {};
}

async function journeyAudits(id: string) {
  const snapshot = await admin()
    .firestore.collection('auditLogs')
    .where('entity', '==', `${JOURNEY_COLLECTION}/${id}`)
    .get();
  return snapshot.docs.map((doc) => doc.data());
}

describe('clearExpiredJourneyPlaces', () => {
  it('is the same 30 day policy as a trip request', () => {
    expect(JOURNEY_PLACES_RETENTION_DAYS).toBe(30);
    expect(JOURNEY_PLACES_RETENTION_DAYS).toBe(TRIP_PLACES_RETENTION_DAYS);
  });

  it('clears the start, end and last position of a completed journey older than 30 days', async () => {
    const id = await journey({ endedAt: endedDaysAgo(31) });
    const outcome = await clearExpiredJourneyPlaces(journeyDeps);
    expect(outcome.cleared).toBeGreaterThanOrEqual(1);

    const data = await readJourney(id);
    expect(data.origin).toBeNull();
    expect(data.destination).toBeNull();
    expect(data.currentLocation).toBeNull();
    expect(data.placesCleared).toBe(true);
  });

  it('clears a cancelled journey the same way', async () => {
    const id = await journey({ status: 'CANCELLED', endedAt: endedDaysAgo(45) });
    await clearExpiredJourneyPlaces(journeyDeps);
    const data = await readJourney(id);
    expect(data.origin).toBeNull();
    expect(data.placesCleared).toBe(true);
  });

  it('keeps the journey itself: its driver, status and matched requests', async () => {
    const id = await journey({ endedAt: endedDaysAgo(31) });
    await clearExpiredJourneyPlaces(journeyDeps);
    expect(await readJourney(id)).toMatchObject({
      driverId: 'retention-driver',
      vehicleId: 'retention-driver',
      status: 'COMPLETED',
      matchedTripRequestIds: ['a', 'b'],
    });
  });

  it('leaves a journey that ended less than 30 days ago alone', async () => {
    const id = await journey({ endedAt: endedDaysAgo(29) });
    await clearExpiredJourneyPlaces(journeyDeps);
    const data = await readJourney(id);
    expect(data.origin).toMatchObject({ formattedAddress: HOME.formattedAddress });
    expect(data.destination).toMatchObject({ formattedAddress: OFFICE.formattedAddress });
    expect(data.currentLocation).not.toBeNull();
    expect(data.placesCleared).toBe(false);
  });

  it.each(['DRAFT', 'AVAILABLE', 'MATCHING', 'ACTIVE'])(
    'never touches a %s journey that has not ended, however old',
    async (status) => {
      const id = await journey({ status, endedAt: null });
      await clearExpiredJourneyPlaces(journeyDeps);
      expect((await readJourney(id)).origin).toMatchObject({
        formattedAddress: HOME.formattedAddress,
      });
    },
  );

  it('never touches an old journey that has no endedAt (it ended before this existed)', async () => {
    const id = await journey({});
    await clearExpiredJourneyPlaces(journeyDeps);
    expect((await readJourney(id)).origin).toMatchObject({
      formattedAddress: HOME.formattedAddress,
    });
  });

  it('refuses to clear a journey whose status is not ended, even with an old endedAt', async () => {
    const id = await journey({ status: 'ACTIVE', endedAt: endedDaysAgo(60) });
    await clearExpiredJourneyPlaces(journeyDeps);
    const data = await readJourney(id);
    expect(data.origin).toMatchObject({ formattedAddress: HOME.formattedAddress });
    expect(data.placesCleared).toBe(false);
  });

  it('audits each clearing without naming any place, under its own action', async () => {
    const id = await journey({ endedAt: endedDaysAgo(31) });
    await clearExpiredJourneyPlaces(journeyDeps);
    const entries = await journeyAudits(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: 'system', action: 'JOURNEY_PLACES_CLEARED' });
    const text = JSON.stringify(entries[0]);
    expect(text).not.toContain(HOME.formattedAddress);
    expect(text).not.toContain(OFFICE.formattedAddress);
    expect(text).not.toContain('51.5');
  });

  it('clears a journey once: a second run does nothing and writes no second audit entry', async () => {
    const id = await journey({ endedAt: endedDaysAgo(31) });
    await clearExpiredJourneyPlaces(journeyDeps);
    await clearExpiredJourneyPlaces(journeyDeps);
    expect(await journeyAudits(id)).toHaveLength(1);
  });
});
