import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  Timestamp,
  deleteDoc,
  deleteField,
  doc,
  collection,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_PORTS } from '../test-ports';

const root = resolve(__dirname, '../..');
let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-ridemesh-rules',
    firestore: {
      rules: readFileSync(join(root, 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: TEST_PORTS.firestore,
    },
  });
});

afterAll(async () => {
  await env.cleanup();
});

function profile(role: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    role,
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.test`,
    phone: null,
    photoUrl: null,
    status: 'ACTIVE',
    createdAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')),
    updatedAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')),
    ...overrides,
  };
}

function driverProfile(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    verificationStatus: 'PENDING',
    availabilityStatus: 'OFFLINE',
    rating: null,
    totalTrips: 0,
    maxDetourMinutes: null,
    maxDetourDistance: null,
    automaticMatchingEnabled: null,
    createdAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')),
    updatedAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')),
    ...overrides,
  };
}

function vehicleDoc(driverId: string, overrides: Record<string, unknown> = {}) {
  return {
    driverId,
    type: 'CAR',
    make: 'Toyota',
    model: 'Corolla',
    plateNumber: 'ABC 123',
    plateKey: 'ABC123',
    seatCapacity: null,
    availableSeats: null,
    verificationStatus: 'PENDING',
    createdAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')),
    updatedAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')),
    ...overrides,
  };
}

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users/passenger-1'), profile('PASSENGER', 'Passenger One'));
    await setDoc(
      doc(db, 'users/driver-1'),
      profile('DRIVER', 'Driver One', { phone: '+441234567' }),
    );
    await setDoc(doc(db, 'drivers/driver-1'), driverProfile('driver-1'));
    await setDoc(doc(db, 'drivers/driver-2'), driverProfile('driver-2'));
    await setDoc(doc(db, 'vehicles/driver-1'), vehicleDoc('driver-1'));
    await setDoc(doc(db, 'vehicles/driver-2'), vehicleDoc('driver-2', { plateKey: 'XYZ999' }));
    await setDoc(doc(db, 'users/staff-1'), profile('ADMIN', 'Staff One'));
    await setDoc(
      doc(db, 'users/suspended-1'),
      profile('PASSENGER', 'Suspended', { status: 'SUSPENDED' }),
    );
    // A document whose stored role says ADMIN must never grant anything on its own.
    await setDoc(doc(db, 'users/forger-1'), profile('ADMIN', 'Forger'));
    await setDoc(doc(db, 'auditLogs/log-1'), { action: 'ROLE_ASSIGNED' });
    await setDoc(doc(db, 'tripRequests/trip-1'), { passengerId: 'passenger-1' });
  });
});

const verified = (role: string) => ({ email_verified: true, role });

describe('users: reading', () => {
  it('lets a verified user read their own profile', async () => {
    const db = env.authenticatedContext('passenger-1', verified('PASSENGER')).firestore();
    await assertSucceeds(getDoc(doc(db, 'users/passenger-1')));
  });

  it('denies a user whose email is not verified, even for their own profile', async () => {
    const db = env
      .authenticatedContext('passenger-1', { email_verified: false, role: 'PASSENGER' })
      .firestore();
    await assertFails(getDoc(doc(db, 'users/passenger-1')));
  });

  it('denies unauthenticated reads', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'users/passenger-1')));
  });

  it.each(['PASSENGER', 'DRIVER'])('denies a %s reading another user profile', async (role) => {
    const db = env.authenticatedContext('driver-1', verified(role)).firestore();
    await assertFails(getDoc(doc(db, 'users/passenger-1')));
  });

  it.each(['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN'])(
    'lets a verified %s read any user profile',
    async (role) => {
      const db = env.authenticatedContext('staff-1', verified(role)).firestore();
      await assertSucceeds(getDoc(doc(db, 'users/passenger-1')));
    },
  );

  it('denies a staff member whose email is not verified', async () => {
    const db = env
      .authenticatedContext('staff-1', { email_verified: false, role: 'ADMIN' })
      .firestore();
    await assertFails(getDoc(doc(db, 'users/passenger-1')));
  });

  it('ignores the role stored in a profile document', async () => {
    const db = env.authenticatedContext('forger-1', verified('PASSENGER')).firestore();
    await assertFails(getDoc(doc(db, 'users/passenger-1')));
  });

  it.each(['admin', 'ROOT', ''])('does not treat the claim "%s" as staff', async (role) => {
    const db = env.authenticatedContext('someone', verified(role)).firestore();
    await assertFails(getDoc(doc(db, 'users/passenger-1')));
  });

  it('denies a user with no role claim reading another profile', async () => {
    const db = env.authenticatedContext('someone', { email_verified: true }).firestore();
    await assertFails(getDoc(doc(db, 'users/passenger-1')));
  });
});

describe('users: a person editing their own contact details', () => {
  const asPassenger = () =>
    env.authenticatedContext('passenger-1', verified('PASSENGER')).firestore();
  const ref = (db: ReturnType<typeof asPassenger>) => doc(db, 'users/passenger-1');
  const stamp = () => serverTimestamp();

  it.each(['PASSENGER', 'DRIVER', 'ADMIN'])(
    'lets a verified %s change their own name and phone',
    async (role) => {
      const db = env.authenticatedContext('passenger-1', verified(role)).firestore();
      await assertSucceeds(
        updateDoc(ref(db), { name: 'New Name', phone: '+44 7700 900123', updatedAt: stamp() }),
      );
    },
  );

  it('lets a person change only their name, or clear their phone', async () => {
    const db = env.authenticatedContext('driver-1', verified('DRIVER')).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users/driver-1'), { name: 'Renamed', updatedAt: stamp() }),
    );
    // The rule needs updatedAt to change, and the emulator's clock is only about a millisecond
    // fine: two updates in the same tick get the same server time and the second is refused (this
    // failed about one run in five before the pause; with 2 ms or more it never did in 600
    // tries). Real Firestore stamps to the microsecond, so this is a test-only concern.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assertSucceeds(updateDoc(doc(db, 'users/driver-1'), { phone: null, updatedAt: stamp() }));
  });

  it('lets a full overwrite through when only allowed fields differ', async () => {
    const db = asPassenger();
    await assertSucceeds(
      setDoc(
        ref(db),
        profile('PASSENGER', 'Passenger One', { name: 'Overwritten', updatedAt: stamp() }),
      ),
    );
  });

  it('requires updatedAt to be written', async () => {
    await assertFails(updateDoc(ref(asPassenger()), { name: 'New Name' }));
  });

  it('rejects an updatedAt that is not the server time', async () => {
    const db = asPassenger();
    await assertFails(
      updateDoc(ref(db), {
        name: 'New Name',
        updatedAt: Timestamp.fromDate(new Date('2030-01-01')),
      }),
    );
    // A client clock reading can equal the emulator's request.time to the millisecond, so use one
    // that is clearly not the server's time.
    await assertFails(
      updateDoc(ref(db), {
        name: 'New Name',
        updatedAt: Timestamp.fromMillis(Date.now() - 60_000),
      }),
    );
  });

  it.each([
    ['role', { role: 'ADMIN' }],
    ['role to another self-service role', { role: 'DRIVER' }],
    ['email', { email: 'attacker@example.test' }],
    ['status', { status: 'SUSPENDED' }],
    ['createdAt', { createdAt: Timestamp.now() }],
    ['photoUrl', { photoUrl: 'https://example.test/x.png' }],
    ['a new field', { isAdmin: true }],
  ])('denies changing %s, even alongside allowed fields', async (_label, extra) => {
    await assertFails(
      updateDoc(ref(asPassenger()), { name: 'New Name', updatedAt: stamp(), ...extra }),
    );
    await assertFails(updateDoc(ref(asPassenger()), { ...extra, updatedAt: stamp() }));
  });

  it('denies removing a locked field', async () => {
    await assertFails(updateDoc(ref(asPassenger()), { role: deleteField(), updatedAt: stamp() }));
    await assertFails(
      updateDoc(ref(asPassenger()), { status: deleteField(), name: 'X', updatedAt: stamp() }),
    );
  });

  it('denies an overwrite that drops or changes locked fields', async () => {
    const db = asPassenger();
    await assertFails(setDoc(ref(db), { name: 'Only Name', updatedAt: stamp() }));
    await assertFails(
      setDoc(ref(db), { ...profile('ADMIN', 'Passenger One'), updatedAt: stamp() }),
    );
  });

  it.each(['', '   ', '\n\t', 'x'.repeat(101)])('denies the name %j', async (name) => {
    await assertFails(updateDoc(ref(asPassenger()), { name, updatedAt: stamp() }));
  });

  it('denies a name that is not a string', async () => {
    await assertFails(updateDoc(ref(asPassenger()), { name: 12345, updatedAt: stamp() }));
    await assertFails(updateDoc(ref(asPassenger()), { name: null, updatedAt: stamp() }));
    await assertFails(updateDoc(ref(asPassenger()), { name: ['Ada'], updatedAt: stamp() }));
    await assertFails(
      updateDoc(ref(asPassenger()), { name: { first: 'Ada' }, updatedAt: stamp() }),
    );
  });

  it.each(['abc', '123', '+44 <script>', 'x'.repeat(33), '1'.repeat(33), '077\t900123'])(
    'denies the phone %j',
    async (phone) => {
      await assertFails(updateDoc(ref(asPassenger()), { phone, updatedAt: stamp() }));
    },
  );

  it('denies a phone that is not a string or null', async () => {
    await assertFails(updateDoc(ref(asPassenger()), { phone: 12345678, updatedAt: stamp() }));
    await assertFails(updateDoc(ref(asPassenger()), { phone: ['+441234567'], updatedAt: stamp() }));
  });

  it.each(['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN'])(
    'denies a %s editing someone else',
    async (role) => {
      const db = env.authenticatedContext('staff-1', verified(role)).firestore();
      await assertFails(
        updateDoc(doc(db, 'users/passenger-1'), { name: 'Hijacked', updatedAt: stamp() }),
      );
    },
  );

  it('denies editing another user, and using a forged ADMIN document to try', async () => {
    const db = env.authenticatedContext('forger-1', verified('PASSENGER')).firestore();
    await assertFails(
      updateDoc(doc(db, 'users/passenger-1'), { name: 'Hijacked', updatedAt: stamp() }),
    );
  });

  it('denies an unverified email and unauthenticated callers', async () => {
    const unverified = env
      .authenticatedContext('passenger-1', { email_verified: false, role: 'PASSENGER' })
      .firestore();
    await assertFails(updateDoc(ref(unverified), { name: 'New Name', updatedAt: stamp() }));
    const anonymous = env.unauthenticatedContext().firestore();
    await assertFails(updateDoc(ref(anonymous), { name: 'New Name', updatedAt: stamp() }));
  });

  it('denies a suspended account', async () => {
    const db = env.authenticatedContext('suspended-1', verified('PASSENGER')).firestore();
    await assertFails(
      updateDoc(doc(db, 'users/suspended-1'), { name: 'New Name', updatedAt: stamp() }),
    );
  });

  it('denies creating or deleting any profile, including your own', async () => {
    const db = asPassenger();
    await assertFails(setDoc(doc(db, 'users/brand-new'), profile('ADMIN', 'Nope')));
    await assertFails(deleteDoc(ref(db)));
    const staff = env.authenticatedContext('staff-1', verified('SUPER_ADMIN')).firestore();
    await assertFails(deleteDoc(doc(staff, 'users/passenger-1')));
    await assertFails(setDoc(doc(staff, 'users/brand-new'), profile('ADMIN', 'Nope')));
  });
});

describe('other collections stay closed', () => {
  it.each([
    'auditLogs/log-1',
    'payments/pay-1',
    'geocodeCache/51.4494_-2.5813',
    'geocodeLimits/passenger-1',
    'geocodeGlobal/lookups',
    'routeCache/abc123',
    'routeLimits/passenger-1',
    'routeGlobal/lookups',
  ])('denies %s to every role', async (path) => {
    for (const role of ['PASSENGER', 'DRIVER', 'ADMIN', 'SUPER_ADMIN']) {
      const db = env.authenticatedContext('passenger-1', verified(role)).firestore();
      await assertFails(getDoc(doc(db, path)));
      await assertFails(setDoc(doc(db, path), { any: 'thing' }));
    }
  });
});

describe('drivers', () => {
  const asDriver = (uid = 'driver-1', claims = verified('DRIVER')) =>
    env.authenticatedContext(uid, claims).firestore();
  const asPassenger = () =>
    env.authenticatedContext('passenger-1', verified('PASSENGER')).firestore();

  it('lets a verified driver read their own driver profile', async () => {
    const snapshot = await assertSucceeds(getDoc(doc(asDriver(), 'drivers/driver-1')));
    expect(snapshot.get('verificationStatus')).toBe('PENDING');
  });

  it('keeps drivers apart', async () => {
    await assertFails(getDoc(doc(asDriver(), 'drivers/driver-2')));
  });

  it('does not let a passenger read a driver profile, even one keyed by their own uid', async () => {
    await assertFails(getDoc(doc(asPassenger(), 'drivers/driver-1')));
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'drivers/passenger-1'), driverProfile('passenger-1'));
    });
    await assertFails(getDoc(doc(asPassenger(), 'drivers/passenger-1')));
  });

  it('requires a verified email', async () => {
    const unverified = asDriver('driver-1', { email_verified: false, role: 'DRIVER' });
    await assertFails(getDoc(doc(unverified, 'drivers/driver-1')));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'drivers/driver-1')));
  });

  it('lets verified staff read any driver profile, and nobody else', async () => {
    for (const role of ['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN']) {
      const db = env.authenticatedContext('staff-1', verified(role)).firestore();
      await assertSucceeds(getDoc(doc(db, 'drivers/driver-1')));
    }
  });

  it('does not trust a role stored in a document', async () => {
    const forger = env.authenticatedContext('forger-1', verified('PASSENGER')).firestore();
    await assertFails(getDoc(doc(forger, 'drivers/driver-1')));
  });

  it('denies every client write, so a driver cannot verify or change themselves', async () => {
    const db = asDriver();
    const path = 'drivers/driver-1';
    await assertFails(updateDoc(doc(db, path), { verificationStatus: 'VERIFIED' }));
    await assertFails(updateDoc(doc(db, path), { totalTrips: 100, rating: 5 }));
    await assertFails(updateDoc(doc(db, path), { availabilityStatus: 'ONLINE' }));
    await assertFails(updateDoc(doc(db, path), { updatedAt: serverTimestamp() }));
    await assertFails(
      setDoc(doc(db, path), driverProfile('driver-1', { verificationStatus: 'VERIFIED' })),
    );
    await assertFails(deleteDoc(doc(db, path)));

    const other = asDriver('driver-3');
    await assertFails(setDoc(doc(other, 'drivers/driver-3'), driverProfile('driver-3')));
    const staff = env.authenticatedContext('staff-1', verified('SUPER_ADMIN')).firestore();
    await assertFails(updateDoc(doc(staff, path), { verificationStatus: 'VERIFIED' }));
    await assertFails(deleteDoc(doc(staff, path)));
  });
});

describe('vehicles', () => {
  const asDriver = (uid = 'driver-1', claims = verified('DRIVER')) =>
    env.authenticatedContext(uid, claims).firestore();

  it('lets a verified driver read their own vehicle', async () => {
    const snapshot = await assertSucceeds(getDoc(doc(asDriver(), 'vehicles/driver-1')));
    expect(snapshot.get('make')).toBe('Toyota');
  });

  it('keeps drivers apart', async () => {
    await assertFails(getDoc(doc(asDriver(), 'vehicles/driver-2')));
  });

  it('does not let a passenger read a vehicle, even one keyed by their own uid', async () => {
    const passenger = env.authenticatedContext('passenger-1', verified('PASSENGER')).firestore();
    await assertFails(getDoc(doc(passenger, 'vehicles/driver-1')));
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'vehicles/passenger-1'), vehicleDoc('passenger-1'));
    });
    await assertFails(getDoc(doc(passenger, 'vehicles/passenger-1')));
  });

  it('requires a verified email', async () => {
    const unverified = asDriver('driver-1', { email_verified: false, role: 'DRIVER' });
    await assertFails(getDoc(doc(unverified, 'vehicles/driver-1')));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'vehicles/driver-1')));
  });

  it('lets verified staff read any vehicle', async () => {
    for (const role of ['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN']) {
      const db = env.authenticatedContext('staff-1', verified(role)).firestore();
      await assertSucceeds(getDoc(doc(db, 'vehicles/driver-1')));
    }
  });

  it('does not trust a role stored in a document', async () => {
    const forger = env.authenticatedContext('forger-1', verified('PASSENGER')).firestore();
    await assertFails(getDoc(doc(forger, 'vehicles/driver-1')));
  });

  it('denies every client write, including to your own vehicle', async () => {
    const db = asDriver();
    const path = 'vehicles/driver-1';
    await assertFails(updateDoc(doc(db, path), { verificationStatus: 'VERIFIED' }));
    await assertFails(updateDoc(doc(db, path), { seatCapacity: 8, availableSeats: 8 }));
    await assertFails(updateDoc(doc(db, path), { plateNumber: 'NEW 1', plateKey: 'NEW1' }));
    await assertFails(setDoc(doc(db, path), vehicleDoc('driver-1', { make: 'Other' })));
    await assertFails(deleteDoc(doc(db, path)));
    await assertFails(
      setDoc(doc(asDriver('driver-3'), 'vehicles/driver-3'), vehicleDoc('driver-3')),
    );
    const staff = env.authenticatedContext('staff-1', verified('SUPER_ADMIN')).firestore();
    await assertFails(updateDoc(doc(staff, path), { verificationStatus: 'VERIFIED' }));
    await assertFails(deleteDoc(doc(staff, path)));
  });
});

describe('driverJourneys', () => {
  const journey = (driverId: string, overrides: Record<string, unknown> = {}) => ({
    driverId,
    vehicleId: driverId,
    origin: null,
    destination: {
      latitude: 51.5,
      longitude: -0.02,
      formattedAddress: 'Office',
      placeId: null,
    },
    departureTime: null,
    availableSeats: null,
    maxDetourMinutes: null,
    maxDetourDistance: null,
    status: 'DRAFT',
    currentLocation: null,
    currentRoute: null,
    createdAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')),
    updatedAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')),
    ...overrides,
  });
  const asDriver = (uid = 'driver-1', claims = verified('DRIVER')) =>
    env.authenticatedContext(uid, claims).firestore();

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'driverJourneys/journey-1'), journey('driver-1'));
      await setDoc(doc(db, 'driverJourneys/journey-2'), journey('driver-2'));
    });
  });

  it('lets a verified driver read their own journey', async () => {
    const snapshot = await assertSucceeds(getDoc(doc(asDriver(), 'driverJourneys/journey-1')));
    expect(snapshot.get('status')).toBe('DRAFT');
  });

  it('keeps journeys apart, whatever their IDs', async () => {
    await assertFails(getDoc(doc(asDriver(), 'driverJourneys/journey-2')));
    await assertFails(getDoc(doc(asDriver('driver-2'), 'driverJourneys/journey-1')));
  });

  it('does not let a passenger read a journey, even one that names them', async () => {
    const passenger = env.authenticatedContext('passenger-1', verified('PASSENGER')).firestore();
    await assertFails(getDoc(doc(passenger, 'driverJourneys/journey-1')));
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'driverJourneys/journey-p'), journey('passenger-1'));
    });
    await assertFails(getDoc(doc(passenger, 'driverJourneys/journey-p')));
  });

  it('requires a verified email', async () => {
    const unverified = asDriver('driver-1', { email_verified: false, role: 'DRIVER' });
    await assertFails(getDoc(doc(unverified, 'driverJourneys/journey-1')));
    await assertFails(
      getDoc(doc(env.unauthenticatedContext().firestore(), 'driverJourneys/journey-1')),
    );
  });

  it('lets verified staff read any journey', async () => {
    for (const role of ['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN']) {
      const db = env.authenticatedContext('staff-1', verified(role)).firestore();
      await assertSucceeds(getDoc(doc(db, 'driverJourneys/journey-1')));
    }
  });

  it('does not trust a role stored in a document', async () => {
    const forger = env.authenticatedContext('forger-1', verified('PASSENGER')).firestore();
    await assertFails(getDoc(doc(forger, 'driverJourneys/journey-1')));
  });

  it('denies every client write, so a driver cannot change or invent a journey', async () => {
    const db = asDriver();
    const path = 'driverJourneys/journey-1';
    await assertFails(updateDoc(doc(db, path), { status: 'ACTIVE' }));
    await assertFails(updateDoc(doc(db, path), { availableSeats: 6, maxDetourMinutes: 90 }));
    await assertFails(setDoc(doc(db, path), journey('driver-1', { status: 'ACTIVE' })));
    await assertFails(setDoc(doc(db, 'driverJourneys/new-one'), journey('driver-1')));
    await assertFails(deleteDoc(doc(db, path)));
    const staff = env.authenticatedContext('staff-1', verified('SUPER_ADMIN')).firestore();
    await assertFails(updateDoc(doc(staff, path), { status: 'ACTIVE' }));
    await assertFails(deleteDoc(doc(staff, path)));
  });
});

describe('tripRequests', () => {
  const trip = (passengerId: string, overrides: Record<string, unknown> = {}) => ({
    passengerId,
    origin: { latitude: 51.5, longitude: -0.1, formattedAddress: 'A', placeId: null },
    destination: { latitude: 51.6, longitude: -0.2, formattedAddress: 'B', placeId: null },
    status: 'REQUESTED',
    matchedDriverId: null,
    ...overrides,
  });
  const as = (uid: string, claims: Record<string, unknown>) =>
    env.authenticatedContext(uid, claims).firestore();

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'tripRequests/trip-1'), trip('passenger-1'));
      await setDoc(doc(db, 'tripRequests/trip-2'), trip('passenger-2'));
    });
  });

  it('lets a verified passenger read their own request', async () => {
    const snapshot = await assertSucceeds(
      getDoc(doc(as('passenger-1', verified('PASSENGER')), 'tripRequests/trip-1')),
    );
    expect(snapshot.get('status')).toBe('REQUESTED');
  });

  it('keeps passengers apart', async () => {
    await assertFails(getDoc(doc(as('passenger-1', verified('PASSENGER')), 'tripRequests/trip-2')));
    await assertFails(getDoc(doc(as('passenger-2', verified('PASSENGER')), 'tripRequests/trip-1')));
  });

  it('does not let drivers or staff read an unmatched request, even one that names them', async () => {
    for (const role of ['DRIVER', 'SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN']) {
      await assertFails(getDoc(doc(as('staff-1', verified(role)), 'tripRequests/trip-1')));
      await assertFails(getDoc(doc(as('passenger-1', verified(role)), 'tripRequests/trip-1')));
    }
  });

  it('lets the matched driver read the request, once matchedDriverId names them (Module 7.1)', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'tripRequests/trip-matched'),
        trip('passenger-1', { status: 'PICKUP_ASSIGNED', matchedDriverId: 'driver-1' }),
      );
    });
    const snapshot = await assertSucceeds(
      getDoc(doc(as('driver-1', verified('DRIVER')), 'tripRequests/trip-matched')),
    );
    expect(snapshot.get('matchedDriverId')).toBe('driver-1');
    // A different driver, and staff, still cannot.
    await assertFails(getDoc(doc(as('driver-2', verified('DRIVER')), 'tripRequests/trip-matched')));
    await assertFails(
      getDoc(doc(as('staff-1', verified('SUPER_ADMIN')), 'tripRequests/trip-matched')),
    );
  });

  it('requires a verified email', async () => {
    const unverified = as('passenger-1', { email_verified: false, role: 'PASSENGER' });
    await assertFails(getDoc(doc(unverified, 'tripRequests/trip-1')));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'tripRequests/trip-1')));
  });

  it('denies every client write, so a passenger cannot change, invent or delete a request', async () => {
    const db = as('passenger-1', verified('PASSENGER'));
    const path = 'tripRequests/trip-1';
    await assertFails(updateDoc(doc(db, path), { status: 'CANCELLED' }));
    await assertFails(updateDoc(doc(db, path), { estimatedFare: 0 }));
    // The estimate is the server's: the passenger who owns the request cannot write it either.
    await assertFails(updateDoc(doc(db, path), { estimatedDistance: 1 }));
    await assertFails(updateDoc(doc(db, path), { estimatedDuration: 1 }));
    await assertFails(updateDoc(doc(db, path), { estimatedDistance: 1, estimatedDuration: 1 }));
    await assertFails(setDoc(doc(db, 'tripRequests/new-one'), trip('passenger-1')));
    await assertFails(deleteDoc(doc(db, path)));
    const staff = as('staff-1', verified('SUPER_ADMIN'));
    await assertFails(updateDoc(doc(staff, path), { status: 'CANCELLED' }));
    await assertFails(deleteDoc(doc(staff, path)));
  });

  it('lets a passenger list their own requests, and only through a query on their own ID', async () => {
    const db = as('passenger-1', verified('PASSENGER'));
    const mine = await assertSucceeds(
      getDocs(query(collection(db, 'tripRequests'), where('passengerId', '==', 'passenger-1'))),
    );
    expect(mine.docs.map((entry) => entry.id)).toEqual(['trip-1']);
    await assertSucceeds(
      getDocs(
        query(
          collection(db, 'tripRequests'),
          where('passengerId', '==', 'passenger-1'),
          orderBy('createdAt', 'desc'),
        ),
      ),
    );
    // Someone else's ID, or no filter at all, would return other people's places: refused.
    await assertFails(
      getDocs(query(collection(db, 'tripRequests'), where('passengerId', '==', 'passenger-2'))),
    );
    await assertFails(getDocs(collection(db, 'tripRequests')));
  });

  it('does not let drivers or staff list requests, whatever they filter on', async () => {
    for (const role of ['DRIVER', 'SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN']) {
      const db = as('passenger-1', verified(role));
      await assertFails(
        getDocs(query(collection(db, 'tripRequests'), where('passengerId', '==', 'passenger-1'))),
      );
      await assertFails(getDocs(collection(db, 'tripRequests')));
    }
  });

  it('does not let a passenger set their own open-request pointer', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'users/passenger-1'), profile('PASSENGER', 'Pat'));
    });
    await assertFails(
      updateDoc(doc(as('passenger-1', verified('PASSENGER')), 'users/passenger-1'), {
        currentTripRequestId: 'trip-2',
        updatedAt: serverTimestamp(),
      }),
    );
  });
});

describe('journeyPlans (Module 7.1)', () => {
  const plan = (driverId: string) => ({
    journeyId: 'journey-1',
    driverId,
    requestIds: ['trip-1'],
    stops: [
      { kind: 'pickup', requestId: 'trip-1' },
      { kind: 'dropoff', requestId: 'trip-1' },
    ],
    totalDistanceMeters: 1000,
    totalDurationSeconds: 200,
    createdAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')),
  });
  const as = (uid: string, claims: Record<string, unknown>) =>
    env.authenticatedContext(uid, claims).firestore();

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'journeyPlans/plan-1'), plan('driver-1'));
    });
  });

  it('lets the driver it belongs to read it', async () => {
    const snapshot = await assertSucceeds(
      getDoc(doc(as('driver-1', verified('DRIVER')), 'journeyPlans/plan-1')),
    );
    expect(snapshot.get('driverId')).toBe('driver-1');
  });

  it('does not let a different driver or a passenger read it', async () => {
    await assertFails(getDoc(doc(as('driver-2', verified('DRIVER')), 'journeyPlans/plan-1')));
    await assertFails(getDoc(doc(as('driver-1', verified('PASSENGER')), 'journeyPlans/plan-1')));
  });

  it('lets verified staff read any plan', async () => {
    for (const role of ['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN']) {
      await assertSucceeds(getDoc(doc(as('staff-1', verified(role)), 'journeyPlans/plan-1')));
    }
  });

  it('requires a verified email', async () => {
    const unverified = as('driver-1', { email_verified: false, role: 'DRIVER' });
    await assertFails(getDoc(doc(unverified, 'journeyPlans/plan-1')));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'journeyPlans/plan-1')));
  });

  it('denies every client write', async () => {
    const db = as('driver-1', verified('DRIVER'));
    await assertFails(updateDoc(doc(db, 'journeyPlans/plan-1'), { driverId: 'driver-2' }));
    await assertFails(setDoc(doc(db, 'journeyPlans/new-one'), plan('driver-1')));
    await assertFails(deleteDoc(doc(db, 'journeyPlans/plan-1')));
  });

  it('lets the driver query their own plan by driverId and journeyId together', async () => {
    const db = as('driver-1', verified('DRIVER'));
    const found = await assertSucceeds(
      getDocs(
        query(
          collection(db, 'journeyPlans'),
          where('driverId', '==', 'driver-1'),
          where('journeyId', '==', 'journey-1'),
        ),
      ),
    );
    expect(found.docs.map((entry) => entry.id)).toEqual(['plan-1']);
  });

  it('refuses a query that filters only on journeyId, even for the plan own driver', async () => {
    // A list query is checked against every document it could possibly return, not just the ones it
    // actually returns - filtering only on a field the rule does not check (journeyId, not driverId)
    // is refused even though this particular result would have passed. packages/firebase's own
    // getJourneyPlanStops filters on both for exactly this reason.
    const db = as('driver-1', verified('DRIVER'));
    await assertFails(
      getDocs(query(collection(db, 'journeyPlans'), where('journeyId', '==', 'journey-1'))),
    );
  });
});
