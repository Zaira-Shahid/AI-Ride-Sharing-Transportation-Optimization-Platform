import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { runBatchOptimization } from '../../functions/src/optimizationRun';
import { captureTripPayment } from '../../functions/src/paymentCapture';
import type { StripeProvider } from '../../functions/src/stripeProvider';
import { admin } from './support';
import {
  account,
  call,
  doc,
  firestore,
  founder,
  joined,
  refused,
  type Founder,
} from './company-support';
import {
  NO_LIMITS,
  clearScenarioCollections,
  geometryOptimizer,
  positionalProvider,
  recordingPush,
} from './golden/consumer-scenario';

// Module A3a: company employees ride and drive through the same functions as consumers, and company
// rides are free (functions + firestore + auth emulators). See docs/a3-company-matching-design.md,
// sections 4 and 5.

beforeEach(clearScenarioCollections);

const SHAPES = JSON.parse(
  readFileSync(join(__dirname, 'golden', 'consumer-document-shapes.golden.json'), 'utf8'),
) as { tripRequestKeys: string[]; driverJourneyKeys: string[] };

let plateCounter = 0;
const plate = () => `RID-${Date.now() % 100000}-${plateCounter++}`;

/** An employee who applied, added a vehicle with seats, and was approved by the administrator. */
async function approvedDriver(boss: Founder, prefix: string) {
  const employee = await joined(boss, prefix);
  await call(employee.client, 'applyToDrive');
  await call(employee.client, 'saveEmployeeVehicle', {
    type: 'CAR',
    make: 'Toyota',
    model: 'Corolla',
    plateNumber: plate(),
  });
  // Seats before approval: setting them sends the vehicle back to pending review.
  await call(employee.client, 'setEmployeeVehicleCapacity', { seatCapacity: 4 });
  await call(boss.client, 'approveEmployeeDriver', { uid: employee.uid });
  return employee;
}
type Employee = Awaited<ReturnType<typeof approvedDriver>>;

/** Everything but going online, at latitude `at` (the journey runs from `at` to `at + 0.05`). */
async function setUpJourney(employee: Employee, at: number) {
  await call(employee.client, 'declareDestination', {
    destination: {
      latitude: at + 0.05,
      longitude: 0,
      formattedAddress: 'Company site',
      placeId: null,
    },
  });
  await call(employee.client, 'setJourneyOrigin', { origin: { latitude: at, longitude: 0 } });
  await call(employee.client, 'setJourneySeats', { availableSeats: 2 });
  await call(employee.client, 'setJourneyDetour', { maxDetourMinutes: 60, maxDetourDistance: 30 });
}

const goOnline = (employee: Employee) =>
  call(employee.client, 'setAvailability', { status: 'ONLINE' });

const journeyOf = async (uid: string) => {
  const driver = await doc(`drivers/${uid}`);
  const id = driver?.currentJourneyId as string;
  return { id, data: await doc(`driverJourneys/${id}`) };
};

const requestRide = (employee: { client: Employee['client'] }, from: number, to: number) =>
  call(employee.client, 'createTripRequest', {
    origin: { latitude: from, longitude: 0, formattedAddress: 'Home', placeId: null },
    destination: { latitude: to, longitude: 0, formattedAddress: 'Company site', placeId: null },
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
  }).then((r) => (r.data as { tripId: string }).tripId);

async function waitFor(tripId: string, status: string) {
  const stop = Date.now() + 20_000;
  for (;;) {
    if ((await doc(`tripRequests/${tripId}`))?.status === status) return;
    if (Date.now() > stop) throw new Error(`Timed out waiting for ${status}.`);
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

describe('company documents', () => {
  it('carry their company, and otherwise have exactly the keys a consumer’s have', async () => {
    const boss = await founder('rides-shape', 'Shape Co');
    const driver = await approvedDriver(boss, 'rides-shape-driver');
    await setUpJourney(driver, 70);
    const journey = await journeyOf(driver.uid);
    expect(journey.data?.companyId).toBe(boss.companyId);
    expect(Object.keys(journey.data ?? {}).sort()).toEqual(
      [...SHAPES.driverJourneyKeys, 'companyId'].sort(),
    );

    const rider = await joined(boss, 'rides-shape-rider');
    const tripId = await requestRide(rider, -40, -39);
    await waitFor(tripId, 'SEARCHING');
    const trip = await doc(`tripRequests/${tripId}`);
    expect(trip?.companyId).toBe(boss.companyId);
    expect(Object.keys(trip ?? {}).sort()).toEqual([...SHAPES.tripRequestKeys, 'companyId'].sort());
    // The company comes from the membership, never from what the client sent.
    expect(trip?.passengerId).toBe(rider.uid);
  });

  it('cannot be given another company by the client', async () => {
    const boss = await founder('rides-forge', 'Forge Co');
    const rider = await joined(boss, 'rides-forge-rider');
    const tripId = (
      await call(rider.client, 'createTripRequest', {
        companyId: 'someone-elses-company',
        origin: { latitude: -40, longitude: 0, formattedAddress: 'Home', placeId: null },
        destination: { latitude: -39, longitude: 0, formattedAddress: 'Site', placeId: null },
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
    ).data as { tripId: string };
    expect((await doc(`tripRequests/${tripId.tripId}`))?.companyId).toBe(boss.companyId);
  });
});

describe('a company ride, from request to completion', () => {
  it('is matched inside the company, runs the normal trip steps, and costs nothing', async () => {
    const boss = await founder('rides-e2e', 'E2E Co');
    const driver = await approvedDriver(boss, 'rides-e2e-driver');
    const rider = await joined(boss, 'rides-e2e-rider');

    // A consumer's journey and a consumer's rider on the SAME line, which must be left alone.
    await firestore()
      .doc('driverJourneys/e2e-consumer-journey')
      .set({
        driverId: 'e2e-consumer-driver',
        status: 'AVAILABLE',
        origin: { latitude: 70, longitude: 0 },
        destination: { latitude: 70.05, longitude: 0 },
        availableSeats: 2,
        maxDetourMinutes: 60,
        maxDetourDistance: 10,
        matchedTripRequestIds: [],
      });
    await firestore().doc('users/e2e-consumer-driver').set({ name: 'Consumer', status: 'ACTIVE' });
    await firestore().doc('vehicles/e2e-consumer-driver').set({ type: 'CAR' });

    await setUpJourney(driver, 70);
    await goOnline(driver);
    const journey = await journeyOf(driver.uid);
    expect(journey.data).toMatchObject({ status: 'AVAILABLE', companyId: boss.companyId });

    const tripId = await requestRide(rider, 70.01, 70.02);
    await waitFor(tripId, 'SEARCHING');

    const outcome = await runBatch();
    expect(outcome.matchedRequestCount).toBe(1);
    expect(await doc(`tripRequests/${tripId}`)).toMatchObject({
      status: 'PICKUP_ASSIGNED',
      matchedJourneyId: journey.id,
      matchedDriverId: driver.uid,
      companyId: boss.companyId,
    });
    // The consumer's journey on the same line was never touched.
    expect(await doc('driverJourneys/e2e-consumer-journey')).toMatchObject({
      status: 'AVAILABLE',
      matchedTripRequestIds: [],
    });

    // Give the trip real distance estimates, so a fare WOULD be worked out if the ride were not free.
    await firestore()
      .doc(`tripRequests/${tripId}`)
      .update({ estimatedDistance: 4000, estimatedDuration: 900 });

    for (const step of [
      'headToPickup',
      'confirmPickup',
      'startTransit',
      'approachDropoff',
      'completeDropoff',
    ]) {
      await call(driver.client, step, { tripId });
    }
    const finished = await doc(`tripRequests/${tripId}`);
    expect(finished?.status).toBe('COMPLETED');
    // Free: no fare was worked out, no payment exists, and no receipt or earning was written.
    expect(finished?.finalFareMinorUnits ?? null).toBeNull();
    expect(finished?.paymentStatus ?? null).toBeNull();
    expect(finished?.platformFeeMinorUnits ?? null).toBeNull();
    expect(finished?.estimatedDistance).toBe(4000);
    expect(
      (await firestore().collection('receipts').where('passengerId', '==', rider.uid).get()).size,
    ).toBe(0);
    expect(
      (await firestore().collection('driverEarnings').where('driverId', '==', driver.uid).get())
        .size,
    ).toBe(0);
  });

  it('never contacts Stripe for a company ride, even one that looks authorized', async () => {
    const calls: string[] = [];
    const stripe = new Proxy(
      {},
      {
        get: (_target, name) => () => {
          calls.push(String(name));
          return Promise.resolve({ status: 'captured' });
        },
      },
    ) as unknown as StripeProvider;
    const complete = (id: string, extra: Record<string, unknown>) =>
      firestore()
        .doc(`tripRequests/${id}`)
        .set({
          passengerId: `${id}-p`,
          status: 'COMPLETED',
          paymentStatus: 'AUTHORIZED',
          paymentIntentId: 'pi_test',
          finalFareMinorUnits: 1250,
          matchedDriverId: `${id}-d`,
          requestedAt: Timestamp.now(),
          ...extra,
        });
    await complete('stripe-company', { companyId: 'some-company' });

    const outcome = await captureTripPayment(
      { firestore: firestore(), stripe, push: recordingPush() },
      'stripe-company',
    );
    expect(outcome).toBe('skipped');
    expect(calls).toEqual([]);
    expect((await doc('tripRequests/stripe-company'))?.paymentStatus).toBe('AUTHORIZED');
  });
});

describe('an employee is held to the same rules as anyone, and a few more', () => {
  it('cannot ask for a ride while they have a journey open, and can once it is closed', async () => {
    const boss = await founder('rides-excl-a', 'Exclusive A Co');
    const driver = await approvedDriver(boss, 'rides-excl-a-driver');
    await setUpJourney(driver, 72);
    await goOnline(driver);

    await expect(requestRide(driver, 72.01, 72.02)).rejects.toMatchObject(
      refused('failed-precondition', 'Go offline'),
    );
    await call(driver.client, 'setAvailability', { status: 'OFFLINE' });
    // Offline, but the journey is still open (draft or available): still refused until it is closed.
    const journey = await journeyOf(driver.uid);
    await firestore().doc(`driverJourneys/${journey.id}`).update({ status: 'COMPLETED' });
    await expect(requestRide(driver, 72.01, 72.02)).resolves.toEqual(expect.any(String));
  });

  it('cannot start driving while they have a ride request open', async () => {
    const boss = await founder('rides-excl-b', 'Exclusive B Co');
    const driver = await approvedDriver(boss, 'rides-excl-b-driver');
    const tripId = await requestRide(driver, 74.01, 74.02);
    await waitFor(tripId, 'SEARCHING');

    await expect(
      call(driver.client, 'declareDestination', {
        destination: { latitude: 74.05, longitude: 0, formattedAddress: 'Site', placeId: null },
      }),
    ).rejects.toMatchObject(refused('failed-precondition', 'ride request'));
    await call(driver.client, 'cancelTripRequest', { tripId });
    await expect(
      call(driver.client, 'declareDestination', {
        destination: { latitude: 74.05, longitude: 0, formattedAddress: 'Site', placeId: null },
      }),
    ).resolves.toMatchObject({ data: { status: 'created' } });
  });

  it('stops driving when the vehicle is edited, but can always go offline', async () => {
    const boss = await founder('rides-lapse', 'Lapse Co');
    const driver = await approvedDriver(boss, 'rides-lapse-driver');
    await setUpJourney(driver, 76);
    await goOnline(driver);

    // Editing the vehicle sends it back to review: the permission is no longer enough.
    await call(driver.client, 'saveEmployeeVehicle', {
      type: 'CAR',
      make: 'Honda',
      model: 'Civic',
      plateNumber: plate(),
    });
    await expect(goOnline(driver)).rejects.toBeDefined();
    await expect(
      call(driver.client, 'setJourneySeats', { availableSeats: 1 }),
    ).rejects.toMatchObject(refused('permission-denied', 'verified'));
    // The edit itself already took them offline (the existing rule), and going offline is always allowed.
    expect((await doc(`drivers/${driver.uid}`))?.availabilityStatus).toBe('OFFLINE');
    await expect(
      call(driver.client, 'setAvailability', { status: 'OFFLINE' }),
    ).resolves.toBeDefined();
  });

  it('cannot do any of it without being approved, or after being removed', async () => {
    const boss = await founder('rides-denied', 'Denied Co');
    const plain = await joined(boss, 'rides-denied-plain');
    await expect(
      call(plain.client, 'declareDestination', {
        destination: { latitude: 78.05, longitude: 0, formattedAddress: 'Site', placeId: null },
      }),
    ).rejects.toMatchObject(refused('permission-denied', 'approved to drive'));

    const rider = await joined(boss, 'rides-denied-rider');
    await call(boss.client, 'removeEmployee', { uid: rider.uid });
    // Their token still names the company: the membership is what counts.
    await expect(requestRide(rider, 78.01, 78.02)).rejects.toMatchObject(
      refused('permission-denied'),
    );
  });

  it('is taken offline, and their riders released, when removed from the company', async () => {
    const boss = await founder('rides-remove', 'Remove Co');
    const driver = await approvedDriver(boss, 'rides-remove-driver');
    await setUpJourney(driver, 80);
    await goOnline(driver);
    const journey = await journeyOf(driver.uid);
    expect(journey.data?.status).toBe('AVAILABLE');

    await call(boss.client, 'removeEmployee', { uid: driver.uid });

    expect((await doc(`drivers/${driver.uid}`))?.availabilityStatus).toBe('OFFLINE');
    expect((await doc(`driverJourneys/${journey.id}`))?.status).toBe('DRAFT');
    // They are not left in the pool for anyone to be matched with.
    const outcome = await runBatch();
    expect(outcome.journeyCount).toBe(0);
  });

  it('is refused the ride functions when the account is a consumer’s, as before', async () => {
    const consumer = await account('rides-consumer');
    await call(consumer.client, 'completeRegistration', { role: 'PASSENGER', name: 'P' });
    await consumer.user.getIdToken(true);
    // A consumer asking to drive is refused exactly as before: the role, not the company, decides.
    await expect(
      call(consumer.client, 'declareDestination', {
        destination: { latitude: 82.05, longitude: 0, formattedAddress: 'Site', placeId: null },
      }),
    ).rejects.toMatchObject(refused('permission-denied'));
  });
});
