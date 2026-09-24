import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import { admin, createClient, signUp, verifyEmail } from './support';

// Module 7.2: headToPickup (PICKUP_ASSIGNED -> DRIVER_ARRIVING) and confirmPickup (DRIVER_ARRIVING ->
// PICKED_UP), both manual driver actions. A request is faked straight into the status under test via
// the admin SDK (bypassing the whole matching/optimization pipeline, which has its own tests) so this
// file is only about the two callables' own rules: who may call them, from which status, and that a
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
async function tripAt(status: string, driverId: string | null) {
  const ref = admin().firestore.collection('tripRequests').doc();
  await ref.set({
    passengerId: 'passenger-fixture',
    passengerName: 'Pat',
    origin: PLACE,
    destination: PLACE,
    status,
    matchedDriverId: driverId,
    matchedJourneyId: driverId ? 'journey-fixture' : null,
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
});
