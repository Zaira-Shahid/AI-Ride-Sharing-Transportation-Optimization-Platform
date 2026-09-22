import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import { admin, createClient, signUp, verifyEmail } from './support';

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
const MIN = 60_000;

const request = (overrides: Record<string, unknown> = {}) => ({
  origin: HOME,
  destination: OFFICE,
  departure: { kind: 'NOW' },
  arriveBy: null,
  preferences: BALANCED,
  ...overrides,
});

async function person(role: 'DRIVER' | 'PASSENGER', prefix: string, verified = true) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
  if (verified) await verifyEmail(user, email);
  else await user.getIdToken(true);
  const call = (name: string, data: unknown) => httpsCallable(client.functions, name)(data);
  return {
    client,
    uid,
    create: async (data: unknown = request()) =>
      ((await call('createTripRequest', data)).data as { tripId: string }).tripId,
    cancel: async (tripId: string) =>
      ((await call('cancelTripRequest', { tripId })).data as { status: string }).status,
    call,
  };
}

/** The reason the server gave for a refusal, or the error code when it gave none. */
async function refusal(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    const { details, code } = error as { details?: { reason?: string }; code?: string };
    return details?.reason ?? code?.replace('functions/', '') ?? 'unknown';
  }
  return 'accepted';
}

const tripDoc = async (id: string) =>
  (await admin().firestore.doc(`tripRequests/${id}`).get()).data();
const userDoc = async (uid: string) => (await admin().firestore.doc(`users/${uid}`).get()).data();
const auditOf = async (id: string) =>
  (
    await admin()
      .firestore.collection('auditLogs')
      .where('entity', '==', `tripRequests/${id}`)
      .get()
  ).docs.map((entry) => entry.data());

describe('createTripRequest (functions + firestore emulators)', () => {
  it('creates a REQUESTED request and points the passenger at it', async () => {
    const passenger = await person('PASSENGER', 'trip-new');
    expect((await userDoc(passenger.uid))?.currentTripRequestId ?? null).toBeNull();

    const tripId = await passenger.create();

    expect(await tripDoc(tripId)).toMatchObject({
      passengerId: passenger.uid,
      origin: HOME,
      destination: OFFICE,
      arrivalDeadline: null,
      passengerPreferences: BALANCED,
      estimatedFare: null,
      // The distance and time are filled in a moment after creation by the estimate trigger (Modules
      // 4.4 and 4.5), from a routing server. None is reachable in this file, so they stay empty here;
      // tests/integration/estimate.int.test.ts is where they are filled.
      estimatedDistance: null,
      estimatedDuration: null,
      assignedPlanId: null,
    });
    // status and candidateCount are also moved on by a trigger a moment after creation (Modules 5.2
    // and 5.3, tests/integration/matching.int.test.ts), so they are not asserted here - this
    // (leave-now) request could already be REQUESTED or SEARCHING by the time this line runs.
    const stored = await tripDoc(tripId);
    expect(stored?.requestedAt).toBeDefined();
    expect(stored?.createdAt).toBeDefined();
    expect(stored?.requestedDepartureTime.toMillis()).toBe(stored?.requestedAt.toMillis());
    expect((await userDoc(passenger.uid))?.currentTripRequestId).toBe(tripId);
  });

  it('stores a chosen departure and arrival time as given', async () => {
    const passenger = await person('PASSENGER', 'trip-times');
    const leaveAt = Math.ceil((Date.now() + 30 * MIN) / MIN) * MIN;
    const arriveBy = leaveAt + 90 * MIN;

    const tripId = await passenger.create(
      request({ departure: { kind: 'AT', at: leaveAt }, arriveBy }),
    );

    const stored = await tripDoc(tripId);
    expect(stored?.requestedDepartureTime.toMillis()).toBe(leaveAt);
    expect(stored?.arrivalDeadline.toMillis()).toBe(arriveBy);
  });

  it('keeps places out of the audit entry', async () => {
    const passenger = await person('PASSENGER', 'trip-audit');
    const tripId = await passenger.create();

    const entries = await auditOf(tripId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: passenger.uid,
      action: 'TRIP_REQUEST_CREATED',
      previousState: null,
      newState: { status: 'REQUESTED' },
    });
    const text = JSON.stringify(entries[0]);
    expect(text).not.toContain('Canada Square');
    expect(text).not.toContain('51.50');
  });

  it('allows only one open request at a time', async () => {
    const passenger = await person('PASSENGER', 'trip-one');
    const first = await passenger.create();

    expect(await refusal(passenger.create())).toBe('ALREADY_OPEN');
    expect((await userDoc(passenger.uid))?.currentTripRequestId).toBe(first);
  });

  it('replaces a pointer to a request that has ended', async () => {
    const passenger = await person('PASSENGER', 'trip-stale');
    const first = await passenger.create();
    await admin().firestore.doc(`tripRequests/${first}`).update({ status: 'COMPLETED' });

    const second = await passenger.create();

    expect(second).not.toBe(first);
    expect((await userDoc(passenger.uid))?.currentTripRequestId).toBe(second);
  });

  it.each([
    ['the same place', { destination: HOME }, 'SAME_PLACE'],
    [
      'places under 50 m apart',
      { destination: { ...HOME, placeId: null, latitude: HOME.latitude + 0.0002 } },
      'SAME_PLACE',
    ],
    ['a place at 0, 0', { origin: { ...HOME, latitude: 0, longitude: 0 } }, 'UNUSABLE_PLACE'],
    ['a latitude out of range', { origin: { ...HOME, latitude: 95 } }, 'INVALID'],
    ['a blank address', { destination: { ...OFFICE, formattedAddress: '  ' } }, 'INVALID'],
    ['no places', { origin: null }, 'INVALID'],
    [
      'a departure that is too soon',
      { departure: { kind: 'AT', at: Date.now() + MIN } },
      'TIME_TOO_SOON',
    ],
    [
      'a departure too far ahead',
      { departure: { kind: 'AT', at: Date.now() + 8 * 24 * 60 * MIN } },
      'TIME_TOO_FAR',
    ],
    ['an arrival time in the past', { arriveBy: Date.now() - MIN }, 'TIME_TOO_SOON'],
    [
      'an arrival before the departure',
      {
        departure: { kind: 'AT', at: Date.now() + 60 * MIN },
        arriveBy: Date.now() + 30 * MIN,
      },
      'ARRIVAL_NOT_AFTER_DEPARTURE',
    ],
    [
      'preferences that are not a level',
      { preferences: { ...BALANCED, maxWalkingDistance: 5000 } },
      'PREFERENCES',
    ],
    [
      'a level that does not match its numbers',
      { preferences: { ...BALANCED, flexibilityLevel: 'STRICT' } },
      'PREFERENCES',
    ],
  ])('refuses %s and stores nothing', async (_name, overrides, reason) => {
    const passenger = await person('PASSENGER', 'trip-bad');

    expect(await refusal(passenger.create(request(overrides)))).toBe(reason);

    expect((await userDoc(passenger.uid))?.currentTripRequestId ?? null).toBeNull();
    const stored = await admin()
      .firestore.collection('tripRequests')
      .where('passengerId', '==', passenger.uid)
      .get();
    expect(stored.empty).toBe(true);
  });

  it('only lets a verified passenger create a request', async () => {
    const driver = await person('DRIVER', 'trip-driver');
    const unverified = await person('PASSENGER', 'trip-unverified', false);

    expect(await refusal(driver.create())).toBe('permission-denied');
    expect(await refusal(unverified.create())).toBe('permission-denied');
    expect(
      await refusal(httpsCallable(createClient().functions, 'createTripRequest')(request())),
    ).toBe('unauthenticated');
  });

  it('refuses a suspended account', async () => {
    const passenger = await person('PASSENGER', 'trip-suspended');
    await admin().firestore.doc(`users/${passenger.uid}`).update({ status: 'SUSPENDED' });

    expect(await refusal(passenger.create())).toBe('ACCOUNT');
  });
});

describe('cancelTripRequest (functions + firestore emulators)', () => {
  it('cancels a REQUESTED or SEARCHING request, clears the pointer and audits it', async () => {
    const passenger = await person('PASSENGER', 'cancel-ok');
    const tripId = await passenger.create();

    expect(await passenger.cancel(tripId)).toBe('cancelled');

    expect((await tripDoc(tripId))?.status).toBe('CANCELLED');
    expect((await userDoc(passenger.uid))?.currentTripRequestId).toBeNull();
    const entries = await auditOf(tripId);
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'TRIP_REQUEST_CANCELLED',
      'TRIP_REQUEST_CREATED',
    ]);
    const cancelEntry = entries.find((entry) => entry.action === 'TRIP_REQUEST_CANCELLED');
    expect(cancelEntry).toMatchObject({ actor: passenger.uid, newState: { status: 'CANCELLED' } });
    // The search-starting trigger (Modules 5.2 and 5.3) may already have moved this (leave-now)
    // request on to SEARCHING by the time it is cancelled here.
    expect(['REQUESTED', 'SEARCHING']).toContain(
      (cancelEntry?.previousState as { status?: string } | undefined)?.status,
    );
  });

  it('is harmless to repeat', async () => {
    const passenger = await person('PASSENGER', 'cancel-twice');
    const tripId = await passenger.create();
    await passenger.cancel(tripId);

    expect(await passenger.cancel(tripId)).toBe('unchanged');
    expect(
      (await auditOf(tripId)).filter((entry) => entry.action === 'TRIP_REQUEST_CANCELLED'),
    ).toHaveLength(1);
  });

  it('lets the passenger request again afterwards', async () => {
    const passenger = await person('PASSENGER', 'cancel-again');
    const first = await passenger.create();
    await passenger.cancel(first);

    const second = await passenger.create();

    expect(second).not.toBe(first);
    expect((await userDoc(passenger.uid))?.currentTripRequestId).toBe(second);
  });

  it('cancels a request that is SEARCHING, and audits the status it was in', async () => {
    const passenger = await person('PASSENGER', 'cancel-searching');
    const tripId = await passenger.create();
    await admin().firestore.doc(`tripRequests/${tripId}`).update({ status: 'SEARCHING' });

    expect(await passenger.cancel(tripId)).toBe('cancelled');

    expect((await tripDoc(tripId))?.status).toBe('CANCELLED');
    expect((await userDoc(passenger.uid))?.currentTripRequestId).toBeNull();
    const entry = (await auditOf(tripId)).find((item) => item.action === 'TRIP_REQUEST_CANCELLED');
    expect(entry).toMatchObject({
      previousState: { status: 'SEARCHING' },
      newState: { status: 'CANCELLED' },
    });
  });

  it.each([
    'MATCHED',
    'PICKUP_ASSIGNED',
    'DRIVER_ARRIVING',
    'PICKED_UP',
    'IN_TRANSIT',
    'COMPLETED',
  ])('does not cancel a request that is %s', async (status) => {
    const passenger = await person('PASSENGER', 'cancel-not-' + status.toLowerCase());
    const tripId = await passenger.create();
    await admin().firestore.doc(`tripRequests/${tripId}`).update({ status });

    expect(await refusal(passenger.cancel(tripId))).toBe('NOT_CANCELLABLE');
    expect((await tripDoc(tripId))?.status).toBe(status);
    expect(
      (await auditOf(tripId)).filter((item) => item.action === 'TRIP_REQUEST_CANCELLED'),
    ).toHaveLength(0);
  });

  it('does not cancel a request that is past REQUESTED', async () => {
    const passenger = await person('PASSENGER', 'cancel-late');
    const tripId = await passenger.create();
    await admin().firestore.doc(`tripRequests/${tripId}`).update({ status: 'MATCHED' });

    expect(await refusal(passenger.cancel(tripId))).toBe('NOT_CANCELLABLE');
    expect((await tripDoc(tripId))?.status).toBe('MATCHED');
  });

  it("reports someone else's or a missing request as not found, and leaves it alone", async () => {
    const owner = await person('PASSENGER', 'cancel-owner');
    const other = await person('PASSENGER', 'cancel-other');
    const tripId = await owner.create();

    expect(await refusal(other.cancel(tripId))).toBe('NOT_FOUND');
    expect(await refusal(other.cancel('does-not-exist'))).toBe('NOT_FOUND');
    // Untouched by the failed cancels; the search-starting trigger (Modules 5.2 and 5.3) may have
    // moved it on to SEARCHING by now regardless.
    expect(['REQUESTED', 'SEARCHING']).toContain((await tripDoc(tripId))?.status);
  });

  it('refuses malformed input and callers who are not verified passengers', async () => {
    const passenger = await person('PASSENGER', 'cancel-bad');
    const driver = await person('DRIVER', 'cancel-driver');

    expect(await refusal(passenger.call('cancelTripRequest', {}))).toBe('INVALID');
    expect(await refusal(passenger.call('cancelTripRequest', { tripId: 'a/b' }))).toBe('INVALID');
    expect(await refusal(driver.cancel('anything'))).toBe('permission-denied');
  });
});
