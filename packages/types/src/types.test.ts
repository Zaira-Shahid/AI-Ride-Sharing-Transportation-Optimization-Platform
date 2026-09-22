import { describe, expect, it } from 'vitest';
import {
  NEW_VEHICLE_DEFAULTS,
  VEHICLE_TYPES,
  isValidPlate,
  normalizePlate,
  NEW_JOURNEY_DEFAULTS,
  declareDestinationInputSchema,
  destinationSchema,
  setJourneySeatsInputSchema,
  setJourneyDetourInputSchema,
  isValidDetourMinutes,
  isValidDetourDistanceKm,
  DETOUR_MINUTES_PRESETS,
  DETOUR_DISTANCE_KM_PRESETS,
  GO_ONLINE_REQUIREMENTS,
  evaluateGoOnline,
  setAvailabilityInputSchema,
  REVIEWER_ROLES,
  REVIEW_DECISIONS,
  REVIEW_TARGETS,
  requestReviewInputSchema,
  reviewInputSchema,
  validateSeatCapacity,
  validateVehicle,
  SEAT_CAPACITY_MAX,
  SEAT_CAPACITY_MIN,
  DRIVER_AVAILABILITY_STATUSES,
  DRIVER_JOURNEY_STATUSES,
  DRIVER_VERIFICATION_STATUSES,
  NEW_DRIVER_PROFILE_DEFAULTS,
  driverAvailabilityStatusSchema,
  driverVerificationStatusSchema,
  FLEXIBILITY_LEVELS,
  PAYMENT_STATUSES,
  STOP_TYPES,
  TRIP_REQUEST_STATUSES,
  USER_ROLES,
  locationSchema,
  userRoleSchema,
} from './index';

describe('state and role enumerations (spec sections 11, 26, 73, 74)', () => {
  it('defines the six roles from the specification', () => {
    expect(USER_ROLES).toEqual([
      'PASSENGER',
      'DRIVER',
      'SUPPORT',
      'OPERATIONS',
      'ADMIN',
      'SUPER_ADMIN',
    ]);
  });

  it('defines the passenger trip states in order', () => {
    expect(TRIP_REQUEST_STATUSES).toEqual([
      'REQUESTED',
      'SEARCHING',
      'MATCHED',
      'PICKUP_ASSIGNED',
      'DRIVER_ARRIVING',
      'PICKED_UP',
      'IN_TRANSIT',
      'DROPOFF_APPROACHING',
      'COMPLETED',
      'CANCELLED',
    ]);
  });

  it('defines the driver journey states', () => {
    expect(DRIVER_JOURNEY_STATUSES).toEqual([
      'DRAFT',
      'AVAILABLE',
      'MATCHING',
      'ACTIVE',
      'PAUSED',
      'COMPLETED',
      'CANCELLED',
    ]);
  });

  it('defines the payment states', () => {
    expect(PAYMENT_STATUSES).toEqual([
      'PENDING',
      'AUTHORIZED',
      'CAPTURED',
      'FAILED',
      'REFUNDED',
      'PARTIALLY_REFUNDED',
      'DISPUTED',
    ]);
  });

  it('defines the stop types and flexibility levels', () => {
    expect(STOP_TYPES).toEqual(['PICKUP', 'DROPOFF', 'DRIVER_ORIGIN', 'DRIVER_DESTINATION']);
    expect(FLEXIBILITY_LEVELS).toEqual(['STRICT', 'BALANCED', 'FLEXIBLE']);
  });

  it('rejects unknown roles', () => {
    expect(userRoleSchema.safeParse('PASSENGER').success).toBe(true);
    expect(userRoleSchema.safeParse('ROOT').success).toBe(false);
  });
});

describe('locationSchema', () => {
  const valid = {
    latitude: 51.5074,
    longitude: -0.1278,
    formattedAddress: 'London, UK',
    placeId: 'place-1',
  };

  it('accepts a complete location', () => {
    expect(locationSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects out-of-range coordinates', () => {
    expect(locationSchema.safeParse({ ...valid, latitude: 91 }).success).toBe(false);
    expect(locationSchema.safeParse({ ...valid, longitude: -181 }).success).toBe(false);
  });

  it('allows placeId to be omitted or null for a raw GPS pin', () => {
    const withoutPlaceId = {
      latitude: valid.latitude,
      longitude: valid.longitude,
      formattedAddress: valid.formattedAddress,
    };
    expect(locationSchema.safeParse(withoutPlaceId).success).toBe(true);
    expect(locationSchema.safeParse({ ...valid, placeId: null }).success).toBe(true);
  });

  it('rejects an empty place id and a missing address', () => {
    expect(locationSchema.safeParse({ ...valid, placeId: '' }).success).toBe(false);
    expect(locationSchema.safeParse({ ...valid, formattedAddress: '' }).success).toBe(false);
  });
});

describe('driver profile (spec section 10)', () => {
  it('defines the verification and availability states', () => {
    expect(DRIVER_VERIFICATION_STATUSES).toEqual(['PENDING', 'VERIFIED', 'REJECTED']);
    expect(DRIVER_AVAILABILITY_STATUSES).toEqual(['OFFLINE', 'ONLINE']);
    expect(driverVerificationStatusSchema.safeParse('VERIFIED').success).toBe(true);
    expect(driverVerificationStatusSchema.safeParse('APPROVED').success).toBe(false);
    expect(driverAvailabilityStatusSchema.safeParse('ONLINE').success).toBe(true);
    expect(driverAvailabilityStatusSchema.safeParse('BUSY').success).toBe(false);
  });

  it('starts a new driver unverified and offline, with no detour settings invented', () => {
    expect(NEW_DRIVER_PROFILE_DEFAULTS).toEqual({
      verificationStatus: 'PENDING',
      verificationReason: null,
      verificationReviewedAt: null,
      availabilityStatus: 'OFFLINE',
      availabilityChangedAt: null,
      rating: null,
      totalTrips: 0,
      maxDetourMinutes: null,
      maxDetourDistance: null,
      automaticMatchingEnabled: null,
      currentJourneyId: null,
    });
  });
});

describe('vehicle (spec section 10)', () => {
  const valid = { type: 'CAR', make: 'Toyota', model: 'Corolla', plateNumber: 'abc-123' } as const;

  it('offers car, van and minibus', () => {
    expect(VEHICLE_TYPES).toEqual(['CAR', 'VAN', 'MINIBUS']);
  });

  it('starts without seats and unverified', () => {
    expect(NEW_VEHICLE_DEFAULTS).toEqual({
      seatCapacity: null,
      availableSeats: null,
      verificationStatus: 'PENDING',
      verificationReason: null,
      verificationReviewedAt: null,
    });
  });

  it('tidies a plate and builds a key without spaces and hyphens', () => {
    expect(normalizePlate('  ab  12-cd ')).toEqual({ plateNumber: 'AB 12-CD', plateKey: 'AB12CD' });
    expect(normalizePlate('AB12CD').plateKey).toBe(normalizePlate('ab 12 cd').plateKey);
  });

  it.each([
    ['ABC-123', true],
    ['AB 12', true],
    ['AB', true],
    ['A', false],
    ['- -', false],
    ['AB#12', false],
    ['ABCDEFGHIJKLM', false],
    ['é12', false],
    ['', false],
  ])('checks the plate %j: %s', (plate, ok) => {
    expect(isValidPlate(normalizePlate(plate))).toBe(ok);
  });

  it('accepts a valid vehicle and returns trimmed, tidied values', () => {
    const result = validateVehicle({ ...valid, make: ' Toyota ', model: ' Corolla ' });
    expect(result).toEqual({
      ok: true,
      data: { type: 'CAR', make: 'Toyota', model: 'Corolla', plateNumber: 'ABC-123' },
    });
  });

  it('reports each problem on its own field', () => {
    const result = validateVehicle({ type: '', make: ' ', model: '', plateNumber: 'A' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(['make', 'model', 'plateNumber', 'type']);
    }
  });

  it('rejects an oversized make or model', () => {
    const result = validateVehicle({ ...valid, make: 'x'.repeat(51), model: 'y'.repeat(51) });
    expect(result.ok).toBe(false);
  });
});

describe('seat capacity', () => {
  it('counts passenger seats only, from 1 to 6', () => {
    expect([SEAT_CAPACITY_MIN, SEAT_CAPACITY_MAX]).toEqual([1, 6]);
  });

  it.each([1, 2, 4, 6])('accepts %s seats', (seats) => {
    expect(validateSeatCapacity(seats)).toEqual({ ok: true, data: { seatCapacity: seats } });
  });

  it.each([0, 7, -1, 2.5, Number.NaN, null])('rejects %s', (seats) => {
    const result = validateSeatCapacity(seats);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Choose between 1 and 6 passenger seats.');
  });
});

describe('verification reviews', () => {
  it('lets only ADMIN and SUPER_ADMIN review', () => {
    expect(REVIEWER_ROLES).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(REVIEW_DECISIONS).toEqual(['VERIFIED', 'REJECTED']);
    expect(REVIEW_TARGETS).toEqual(['DRIVER', 'VEHICLE']);
  });

  it('accepts a verification, with or without a reason, and trims the reason', () => {
    expect(reviewInputSchema.safeParse({ driverId: 'abc', decision: 'VERIFIED' }).success).toBe(
      true,
    );
    const rejected = reviewInputSchema.parse({
      driverId: ' abc ',
      decision: 'REJECTED',
      reason: '  No.  ',
    });
    expect(rejected).toEqual({ driverId: 'abc', decision: 'REJECTED', reason: 'No.' });
  });

  it.each([undefined, null, '', '   ', 'x'.repeat(501)])(
    'refuses a rejection with reason %j',
    (reason) => {
      expect(
        reviewInputSchema.safeParse({ driverId: 'abc', decision: 'REJECTED', reason }).success,
      ).toBe(false);
    },
  );

  it.each(['users/abc', '..', 'a b', '', 'a'.repeat(129)])('refuses the id %j', (driverId) => {
    expect(reviewInputSchema.safeParse({ driverId, decision: 'VERIFIED' }).success).toBe(false);
  });

  it('only lets a driver ask for a driver or vehicle review', () => {
    expect(requestReviewInputSchema.safeParse({ target: 'DRIVER' }).success).toBe(true);
    expect(requestReviewInputSchema.safeParse({ target: 'VEHICLE' }).success).toBe(true);
    expect(requestReviewInputSchema.safeParse({ target: 'PASSENGER' }).success).toBe(false);
  });
});

describe('going online', () => {
  const ready = {
    accountActive: true,
    driverStatus: 'VERIFIED',
    vehicleStatus: 'VERIFIED',
    seatCapacity: 4,
    destinationDeclared: true,
    originSet: true,
    availableSeats: 3,
    maxDetourMinutes: 10,
    maxDetourDistance: 5,
  } as const;

  it('lists the requirements in the order the driver sees them', () => {
    expect(GO_ONLINE_REQUIREMENTS).toEqual([
      'accountActive',
      'driverVerified',
      'vehicleAdded',
      'vehicleVerified',
      'seatsSet',
      'destinationDeclared',
      'originSet',
      'seatsOffered',
      'detourSet',
    ]);
  });

  it('lets a verified driver with a verified vehicle and seats go online', () => {
    const result = evaluateGoOnline(ready);
    expect(result.eligible).toBe(true);
    expect(result.checks.every((check) => check.met)).toBe(true);
  });

  it.each([
    ['an inactive account', { accountActive: false }, 'accountActive'],
    ['a pending driver', { driverStatus: 'PENDING' }, 'driverVerified'],
    ['a rejected driver', { driverStatus: 'REJECTED' }, 'driverVerified'],
    ['no driver profile', { driverStatus: null }, 'driverVerified'],
    ['a pending vehicle', { vehicleStatus: 'PENDING' }, 'vehicleVerified'],
    ['a rejected vehicle', { vehicleStatus: 'REJECTED' }, 'vehicleVerified'],
    ['no seats set', { seatCapacity: null }, 'seatsSet'],
    ['no destination', { destinationDeclared: false }, 'destinationDeclared'],
    ['no journey start', { originSet: false }, 'originSet'],
    ['no seats on offer', { availableSeats: null }, 'seatsOffered'],
    ['zero seats on offer', { availableSeats: 0 }, 'seatsOffered'],
    ['a fraction of a seat on offer', { availableSeats: 2.5 }, 'seatsOffered'],
    ['more seats than the vehicle has', { availableSeats: 5 }, 'seatsOffered'],
    ['no detour minutes', { maxDetourMinutes: null }, 'detourSet'],
    ['no detour distance', { maxDetourDistance: null }, 'detourSet'],
    ['zero detour minutes', { maxDetourMinutes: 0 }, 'detourSet'],
    ['too many detour minutes', { maxDetourMinutes: 61 }, 'detourSet'],
    ['zero detour kilometres', { maxDetourDistance: 0 }, 'detourSet'],
    ['too many detour kilometres', { maxDetourDistance: 31 }, 'detourSet'],
    ['a fraction of a detour minute', { maxDetourMinutes: 7.5 }, 'detourSet'],
  ] as const)('does not let a driver with %s go online', (_label, change, requirement) => {
    const result = evaluateGoOnline({ ...ready, ...change });
    expect(result.eligible).toBe(false);
    expect(result.checks.find((check) => check.requirement === requirement)?.met).toBe(false);
  });

  it('reports no vehicle as missing, with no seats and no verification', () => {
    const result = evaluateGoOnline({ ...ready, vehicleStatus: null, seatCapacity: 4 });
    const unmet = result.checks.filter((check) => !check.met).map((check) => check.requirement);
    expect(unmet).toEqual(['vehicleAdded', 'vehicleVerified', 'seatsSet', 'seatsOffered']);
  });

  it('only accepts ONLINE and OFFLINE', () => {
    expect(setAvailabilityInputSchema.safeParse({ status: 'ONLINE' }).success).toBe(true);
    expect(setAvailabilityInputSchema.safeParse({ status: 'OFFLINE' }).success).toBe(true);
    expect(setAvailabilityInputSchema.safeParse({ status: 'BUSY' }).success).toBe(false);
  });
});

describe('journeys and destinations', () => {
  const office = {
    latitude: 51.5049,
    longitude: -0.0195,
    formattedAddress: '1 Canada Square, London E14 5AB, UK',
    placeId: 'place-1',
  };

  it('starts a new journey as a draft with nothing but a destination', () => {
    expect(NEW_JOURNEY_DEFAULTS).toEqual({
      origin: null,
      departureTime: null,
      availableSeats: null,
      maxDetourMinutes: null,
      maxDetourDistance: null,
      status: 'DRAFT',
      currentLocation: null,
      currentRoute: null,
      matchedTripRequestId: null,
    });
  });

  it('accepts a place with or without a place ID, and trims the address', () => {
    expect(destinationSchema.safeParse(office).success).toBe(true);
    expect(destinationSchema.safeParse({ ...office, placeId: undefined }).success).toBe(true);
    expect(destinationSchema.safeParse({ ...office, placeId: null }).success).toBe(true);
    const trimmed = destinationSchema.parse({ ...office, formattedAddress: '  Office  ' });
    expect(trimmed.formattedAddress).toBe('Office');
  });

  it.each([
    ['a latitude above 90', { latitude: 90.1 }],
    ['a latitude below -90', { latitude: -90.1 }],
    ['a longitude above 180', { longitude: 180.1 }],
    ['a longitude below -180', { longitude: -180.1 }],
    ['a latitude that is not a number', { latitude: Number.NaN }],
    ['coordinates as text', { latitude: '51.5' }],
    ['a blank address', { formattedAddress: '   ' }],
    ['an oversized address', { formattedAddress: 'x'.repeat(301) }],
    ['an empty place ID', { placeId: '' }],
    ['an oversized place ID', { placeId: 'x'.repeat(301) }],
  ])('refuses %s', (_label, change) => {
    expect(destinationSchema.safeParse({ ...office, ...change }).success).toBe(false);
  });

  it('accepts the edges of the coordinate range', () => {
    for (const [latitude, longitude] of [
      [90, 180],
      [-90, -180],
      [0, 0],
    ]) {
      expect(destinationSchema.safeParse({ ...office, latitude, longitude }).success).toBe(true);
    }
  });

  it('wraps the destination in the declare request', () => {
    expect(declareDestinationInputSchema.safeParse({ destination: office }).success).toBe(true);
    expect(declareDestinationInputSchema.safeParse({}).success).toBe(false);
    expect(declareDestinationInputSchema.safeParse(office).success).toBe(false);
  });
});

describe('seats on offer', () => {
  it('accepts whole seats from one to the largest vehicle', () => {
    for (let availableSeats = 1; availableSeats <= SEAT_CAPACITY_MAX; availableSeats += 1) {
      expect(setJourneySeatsInputSchema.safeParse({ availableSeats }).success).toBe(true);
    }
  });

  it.each([0, -1, SEAT_CAPACITY_MAX + 1, 2.5, '3', null, undefined, Number.NaN])(
    'refuses %s',
    (availableSeats) => {
      expect(setJourneySeatsInputSchema.safeParse({ availableSeats }).success).toBe(false);
    },
  );

  it('needs the seats to be given', () => {
    expect(setJourneySeatsInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('maximum detour', () => {
  it('accepts whole minutes from 1 to 60 and whole kilometres from 1 to 30', () => {
    for (const [minutes, km] of [
      [1, 1],
      [60, 30],
      [10, 5],
    ]) {
      expect(
        setJourneyDetourInputSchema.safeParse({ maxDetourMinutes: minutes, maxDetourDistance: km })
          .success,
      ).toBe(true);
    }
  });

  it.each([
    ['zero minutes', { maxDetourMinutes: 0, maxDetourDistance: 5 }],
    ['61 minutes', { maxDetourMinutes: 61, maxDetourDistance: 5 }],
    ['zero kilometres', { maxDetourMinutes: 10, maxDetourDistance: 0 }],
    ['31 kilometres', { maxDetourMinutes: 10, maxDetourDistance: 31 }],
    ['fractions', { maxDetourMinutes: 7.5, maxDetourDistance: 2.5 }],
    ['negative numbers', { maxDetourMinutes: -5, maxDetourDistance: -1 }],
    ['text', { maxDetourMinutes: '10', maxDetourDistance: '5' }],
    ['only minutes', { maxDetourMinutes: 10 }],
    ['only kilometres', { maxDetourDistance: 5 }],
    ['nothing', {}],
  ])('refuses %s', (_label, input) => {
    expect(setJourneyDetourInputSchema.safeParse(input).success).toBe(false);
  });

  it('offers presets that are all valid', () => {
    expect(DETOUR_MINUTES_PRESETS.every((value) => isValidDetourMinutes(value))).toBe(true);
    expect(DETOUR_DISTANCE_KM_PRESETS.every((value) => isValidDetourDistanceKm(value))).toBe(true);
    expect(isValidDetourMinutes(null)).toBe(false);
    expect(isValidDetourDistanceKm(Number.NaN)).toBe(false);
  });
});
