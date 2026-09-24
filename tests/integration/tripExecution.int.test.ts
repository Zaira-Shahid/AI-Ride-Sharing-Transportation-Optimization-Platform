import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import { admin, createClient, signUp, verifyEmail } from './support';

// Module 7.2: headToPickup (PICKUP_ASSIGNED -> DRIVER_ARRIVING) and confirmPickup (DRIVER_ARRIVING ->
// PICKED_UP). Module 7.4 adds startTransit (PICKED_UP -> IN_TRANSIT), stop-order enforcement for the
// two pickup actions, and the journey's own MATCHING -> ACTIVE move on the first confirmed pickup.
// All three actions are manual driver actions. A request is faked straight into the status under test
// via the admin SDK (bypassing the whole matching/optimization pipeline, which has its own tests) so
// this file is only about the callables' own rules: who may call them, from which status, and that a
// repeat call is harmless.

const PLACE = { latitude: 51.5, longitude: -0.1, formattedAddress: 'A place', placeId: null };

async function person(role: 'DRIVER' | 'PASSENGER', prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
  await verifyEmail(user, email);
  const call = (name: string, data: unknown) => httpsCallable(client.functions, name)(data);
  return { client, uid, call };
}

/** A tripRequests fixture at `status`, matched to `driverId` (or nobody, when null). */
async function tripAt(
  status: string,
  driverId: string | null,
  extra: { journeyId?: string; assignedPlanId?: string } = {},
) {
  const ref = admin().firestore.collection('tripRequests').doc();
  await ref.set({
    passengerId: 'passenger-fixture',
    passengerName: 'Pat',
    origin: PLACE,
    destination: PLACE,
    status,
    matchedDriverId: driverId,
    matchedJourneyId: driverId ? (extra.journeyId ?? 'journey-fixture') : null,
    assignedPlanId: extra.assignedPlanId ?? null,
  });
  return ref.id;
}

/** The reason the server gave for a refusal, or the error code when it gave none. */
async function refusal(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    const { details, code } = error as { details?: { reason?: string }; code?: string };
    return details?.reason ?? code?.replace('functions/', '') ?? 'unknown';
  }
  return 'none';
}

describe('headToPickup (functions + firestore emulators)', () => {
  it('moves the matched driver own request from PICKUP_ASSIGNED to DRIVER_ARRIVING', async () => {
    const driver = await person('DRIVER', 'head-ok');
    const tripId = await tripAt('PICKUP_ASSIGNED', driver.uid);

    const result = await driver.call('headToPickup', { tripId });
    expect((result.data as { status: string }).status).toBe('updated');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('DRIVER_ARRIVING');
  });

  it('is unchanged, not an error, when already DRIVER_ARRIVING', async () => {
    const driver = await person('DRIVER', 'head-again');
    const tripId = await tripAt('DRIVER_ARRIVING', driver.uid);

    const result = await driver.call('headToPickup', { tripId });
    expect((result.data as { status: string }).status).toBe('unchanged');
  });

  it('refuses a status other than PICKUP_ASSIGNED or DRIVER_ARRIVING', async () => {
    const driver = await person('DRIVER', 'head-wrong');
    const tripId = await tripAt('SEARCHING', driver.uid);

    expect(await refusal(driver.call('headToPickup', { tripId }))).toBe('WRONG_STATUS');
    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('SEARCHING');
  });

  it("reports someone else's request, or a missing one, as not found", async () => {
    const driver = await person('DRIVER', 'head-owner');
    const other = await person('DRIVER', 'head-other');
    const tripId = await tripAt('PICKUP_ASSIGNED', driver.uid);

    expect(await refusal(other.call('headToPickup', { tripId }))).toBe('NOT_FOUND');
    expect(await refusal(other.call('headToPickup', { tripId: 'does-not-exist' }))).toBe(
      'NOT_FOUND',
    );

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('PICKUP_ASSIGNED');
  });

  it('refuses a passenger caller', async () => {
    const driver = await person('DRIVER', 'head-role-d');
    const passenger = await person('PASSENGER', 'head-role-p');
    const tripId = await tripAt('PICKUP_ASSIGNED', driver.uid);

    expect(await refusal(passenger.call('headToPickup', { tripId }))).toBe('permission-denied');
  });
});

describe('confirmPickup (functions + firestore emulators)', () => {
  it('moves the matched driver own request from DRIVER_ARRIVING to PICKED_UP', async () => {
    const driver = await person('DRIVER', 'confirm-ok');
    const tripId = await tripAt('DRIVER_ARRIVING', driver.uid);

    const result = await driver.call('confirmPickup', { tripId });
    expect((result.data as { status: string }).status).toBe('updated');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('PICKED_UP');
  });

  it('is unchanged, not an error, when already PICKED_UP', async () => {
    const driver = await person('DRIVER', 'confirm-again');
    const tripId = await tripAt('PICKED_UP', driver.uid);

    const result = await driver.call('confirmPickup', { tripId });
    expect((result.data as { status: string }).status).toBe('unchanged');
  });

  it('refuses a request still only PICKUP_ASSIGNED (must head to pickup first)', async () => {
    const driver = await person('DRIVER', 'confirm-early');
    const tripId = await tripAt('PICKUP_ASSIGNED', driver.uid);

    expect(await refusal(driver.call('confirmPickup', { tripId }))).toBe('WRONG_STATUS');
  });

  it("reports someone else's request as not found", async () => {
    const driver = await person('DRIVER', 'confirm-owner');
    const other = await person('DRIVER', 'confirm-other');
    const tripId = await tripAt('DRIVER_ARRIVING', driver.uid);

    expect(await refusal(other.call('confirmPickup', { tripId }))).toBe('NOT_FOUND');
  });

  it('moves the journey from MATCHING to ACTIVE on the first confirmed pickup', async () => {
    const driver = await person('DRIVER', 'confirm-activate');
    const journeyRef = admin().firestore.collection('driverJourneys').doc();
    await journeyRef.set({ driverId: driver.uid, status: 'MATCHING' });
    const tripId = await tripAt('DRIVER_ARRIVING', driver.uid, { journeyId: journeyRef.id });

    await driver.call('confirmPickup', { tripId });

    expect((await journeyRef.get()).data()?.status).toBe('ACTIVE');
  });

  it('leaves an already-ACTIVE journey alone (second passenger picked up)', async () => {
    const driver = await person('DRIVER', 'confirm-already-active');
    const journeyRef = admin().firestore.collection('driverJourneys').doc();
    await journeyRef.set({ driverId: driver.uid, status: 'ACTIVE' });
    const tripId = await tripAt('DRIVER_ARRIVING', driver.uid, { journeyId: journeyRef.id });

    await driver.call('confirmPickup', { tripId });

    expect((await journeyRef.get()).data()?.status).toBe('ACTIVE');
  });
});

describe('startTransit (functions + firestore emulators)', () => {
  it('moves the matched driver own request from PICKED_UP to IN_TRANSIT', async () => {
    const driver = await person('DRIVER', 'transit-ok');
    const tripId = await tripAt('PICKED_UP', driver.uid);

    const result = await driver.call('startTransit', { tripId });
    expect((result.data as { status: string }).status).toBe('updated');

    const trip = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data();
    expect(trip?.status).toBe('IN_TRANSIT');
  });

  it('is unchanged, not an error, when already IN_TRANSIT', async () => {
    const driver = await person('DRIVER', 'transit-again');
    const tripId = await tripAt('IN_TRANSIT', driver.uid);

    const result = await driver.call('startTransit', { tripId });
    expect((result.data as { status: string }).status).toBe('unchanged');
  });

  it('refuses a request still only DRIVER_ARRIVING (must confirm pickup first)', async () => {
    const driver = await person('DRIVER', 'transit-early');
    const tripId = await tripAt('DRIVER_ARRIVING', driver.uid);

    expect(await refusal(driver.call('startTransit', { tripId }))).toBe('WRONG_STATUS');
  });

  it("reports someone else's request as not found", async () => {
    const driver = await person('DRIVER', 'transit-owner');
    const other = await person('DRIVER', 'transit-other');
    const tripId = await tripAt('PICKED_UP', driver.uid);

    expect(await refusal(other.call('startTransit', { tripId }))).toBe('NOT_FOUND');
  });
});

describe('stop-order enforcement (Module 7.4, functions + firestore emulators)', () => {
  it('refuses headToPickup for a later pickup stop while an earlier one is still pending', async () => {
    const driver = await person('DRIVER', 'order-head');
    const first = await tripAt('PICKUP_ASSIGNED', driver.uid, { journeyId: 'journey-order-1' });
    const second = await tripAt('PICKUP_ASSIGNED', driver.uid, { journeyId: 'journey-order-1' });
    const planRef = admin().firestore.collection('journeyPlans').doc();
    await planRef.set({
      journeyId: 'journey-order-1',
      driverId: driver.uid,
      stops: [
        { kind: 'pickup', requestId: first },
        { kind: 'pickup', requestId: second },
        { kind: 'dropoff', requestId: first },
        { kind: 'dropoff', requestId: second },
      ],
    });
    await admin().firestore.doc(`tripRequests/${first}`).update({ assignedPlanId: planRef.id });
    await admin().firestore.doc(`tripRequests/${second}`).update({ assignedPlanId: planRef.id });

    // The later stop (second) is refused while the earlier one (first) has not reached it yet.
    expect(await refusal(driver.call('headToPickup', { tripId: second }))).toBe('WRONG_STATUS');
    expect((await admin().firestore.doc(`tripRequests/${second}`).get()).data()?.status).toBe(
      'PICKUP_ASSIGNED',
    );

    // The earlier stop is unaffected and can proceed.
    const firstResult = await driver.call('headToPickup', { tripId: first });
    expect((firstResult.data as { status: string }).status).toBe('updated');

    // Once the earlier pickup has actually been completed (PICKED_UP), the later one is free.
    await admin().firestore.doc(`tripRequests/${first}`).update({ status: 'PICKED_UP' });
    const secondResult = await driver.call('headToPickup', { tripId: second });
    expect((secondResult.data as { status: string }).status).toBe('updated');
  });

  it('never blocks startTransit on plan order (a picked-up passenger cannot jump ahead)', async () => {
    const driver = await person('DRIVER', 'order-transit');
    const first = await tripAt('PICKUP_ASSIGNED', driver.uid, { journeyId: 'journey-order-2' });
    const second = await tripAt('PICKED_UP', driver.uid, { journeyId: 'journey-order-2' });
    const planRef = admin().firestore.collection('journeyPlans').doc();
    await planRef.set({
      journeyId: 'journey-order-2',
      driverId: driver.uid,
      stops: [
        { kind: 'pickup', requestId: first },
        { kind: 'pickup', requestId: second },
      ],
    });
    await admin().firestore.doc(`tripRequests/${second}`).update({ assignedPlanId: planRef.id });

    const result = await driver.call('startTransit', { tripId: second });
    expect((result.data as { status: string }).status).toBe('updated');
  });
});
