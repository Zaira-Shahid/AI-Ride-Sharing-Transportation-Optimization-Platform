import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runBatchOptimization } from '../../functions/src/optimizationRun';
import { admin } from './support';
import { account, call, doc, founder, joined, refused, type Founder } from './company-support';
import {
  NO_LIMITS,
  clearScenarioCollections,
  geometryOptimizer,
  positionalProvider,
  recordingPush,
} from './golden/consumer-scenario';

// Module A3b through the real callables, with real accounts: a company driver declines or confirms a
// match, and nobody else can. The decline logic itself is covered in driver-decline.int.test.ts.

beforeEach(clearScenarioCollections);
afterAll(clearScenarioCollections);

let plateCounter = 0;
const plate = () => `DCL-${Date.now() % 100000}-${plateCounter++}`;

async function approvedDriver(boss: Founder, prefix: string) {
  const employee = await joined(boss, prefix);
  await call(employee.client, 'applyToDrive');
  await call(employee.client, 'saveEmployeeVehicle', {
    type: 'CAR',
    make: 'Toyota',
    model: 'Corolla',
    plateNumber: plate(),
  });
  await call(employee.client, 'setEmployeeVehicleCapacity', { seatCapacity: 4 });
  await call(boss.client, 'approveEmployeeDriver', { uid: employee.uid });
  return employee;
}

async function onlineAt(employee: Awaited<ReturnType<typeof approvedDriver>>, at: number) {
  await call(employee.client, 'declareDestination', {
    destination: { latitude: at + 0.05, longitude: 0, formattedAddress: 'Site', placeId: null },
  });
  await call(employee.client, 'setJourneyOrigin', { origin: { latitude: at, longitude: 0 } });
  await call(employee.client, 'setJourneySeats', { availableSeats: 2 });
  await call(employee.client, 'setJourneyDetour', { maxDetourMinutes: 60, maxDetourDistance: 30 });
  await call(employee.client, 'setAvailability', { status: 'ONLINE' });
}

const requestRide = async (client: Awaited<ReturnType<typeof joined>>['client'], from: number) =>
  (
    (
      await call(client, 'createTripRequest', {
        origin: { latitude: from, longitude: 0, formattedAddress: 'Home', placeId: null },
        destination: {
          latitude: from + 0.01,
          longitude: 0,
          formattedAddress: 'Site',
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
      })
    ).data as { tripId: string }
  ).tripId;

async function waitForSearching(tripId: string) {
  const stop = Date.now() + 20_000;
  for (;;) {
    if ((await doc(`tripRequests/${tripId}`))?.status === 'SEARCHING') return;
    if (Date.now() > stop) throw new Error('Timed out waiting for SEARCHING.');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const runBatch = () =>
  runBatchOptimization({
    firestore: admin().firestore,
    provider: positionalProvider(),
    limits: NO_LIMITS,
    optimizationService: { baseUrl: 'https://opt.example', fetchImpl: geometryOptimizer() },
    push: recordingPush(),
  });

/** A company with an approved, online driver and a rider who has been matched to them. */
async function matched(prefix: string, at: number) {
  const boss = await founder(prefix, `${prefix} Co`);
  const driver = await approvedDriver(boss, `${prefix}-driver`);
  const rider = await joined(boss, `${prefix}-rider`);
  await onlineAt(driver, at);
  const tripId = await requestRide(rider.client, at + 0.01);
  await waitForSearching(tripId);
  await runBatch();
  expect(await doc(`tripRequests/${tripId}`)).toMatchObject({
    status: 'PICKUP_ASSIGNED',
    matchedDriverId: driver.uid,
    driverDecision: { status: 'OPEN' },
  });
  return { boss, driver, rider, tripId };
}

describe('declining and confirming through the real functions', () => {
  it('lets the matched employee driver decline, and releases the rider', async () => {
    const { driver, rider, tripId } = await matched('dcl-a', 76);

    expect((await call(driver.client, 'declineMatchedRider', { tripId })).data).toEqual({
      status: 'declined',
    });
    expect(await doc(`tripRequests/${tripId}`)).toMatchObject({
      status: 'SEARCHING',
      matchedDriverId: null,
      declineCount: 1,
    });
    const journeyId = (await doc(`drivers/${driver.uid}`))?.currentJourneyId as string;
    expect((await doc(`driverJourneys/${journeyId}`))?.status).toBe('AVAILABLE');
    // The rider was told.
    const notices = await admin()
      .firestore.collection('notifications')
      .where('recipientId', '==', rider.uid)
      .get();
    expect(notices.docs.map((d) => d.get('type'))).toContain('RELEASED_TO_SEARCHING');
  });

  it('lets the matched employee driver confirm early, which ends the window', async () => {
    const { driver, tripId } = await matched('dcl-b', 78);
    expect((await call(driver.client, 'confirmMatchedRider', { tripId })).data).toEqual({
      status: 'confirmed',
    });
    await expect(call(driver.client, 'declineMatchedRider', { tripId })).rejects.toMatchObject(
      refused('failed-precondition'),
    );
    expect((await doc(`tripRequests/${tripId}`))?.status).toBe('PICKUP_ASSIGNED');
  });

  it('is refused for the rider, a colleague, another company and a consumer driver', async () => {
    const { boss, rider, tripId } = await matched('dcl-c', 80);
    const colleague = await approvedDriver(boss, 'dcl-c-colleague');
    const other = await founder('dcl-c-other', 'Other Co');
    const outsider = await approvedDriver(other, 'dcl-c-outsider');
    const consumer = await account('dcl-c-consumer');
    await call(consumer.client, 'completeRegistration', { role: 'DRIVER', name: 'Consumer' });
    await consumer.user.getIdToken(true);

    // The rider is not approved to drive at all.
    await expect(call(rider.client, 'declineMatchedRider', { tripId })).rejects.toMatchObject(
      refused('permission-denied'),
    );
    // Drivers who are not this ride's driver, in any company, or a consumer's driver, are told only that
    // there is no such ride: the same answer as for a ride that does not exist.
    for (const caller of [colleague, outsider, consumer]) {
      await expect(call(caller.client, 'declineMatchedRider', { tripId })).rejects.toMatchObject(
        refused('not-found'),
      );
      await expect(call(caller.client, 'confirmMatchedRider', { tripId })).rejects.toMatchObject(
        refused('not-found'),
      );
    }
    expect(await doc(`tripRequests/${tripId}`)).toMatchObject({
      status: 'PICKUP_ASSIGNED',
      driverDecision: { status: 'OPEN' },
    });
  });
});
