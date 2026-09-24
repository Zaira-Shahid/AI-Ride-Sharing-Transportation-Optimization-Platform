import {
  SELF_SERVICE_ROLES as functionsSelfService,
  STAFF_ROLES as functionsStaff,
  USER_STATUSES as functionsStatuses,
} from '../functions/src/roles';
import { NEW_DRIVER_PROFILE_DEFAULTS as functionsDriverDefaults } from '../functions/src/drivers';
import {
  NEW_JOURNEY_DEFAULTS as functionsJourneyDefaults,
  declareDestinationInputSchema as functionsDestinationSchema,
  setJourneySeatsInputSchema as functionsSeatsSchema,
  setJourneyDetourInputSchema as functionsDetourSchema,
  DETOUR_DISTANCE_KM_MAX as functionsDetourKmMax,
  DETOUR_DISTANCE_KM_MIN as functionsDetourKmMin,
  DETOUR_MINUTES_MAX as functionsDetourMinutesMax,
  DETOUR_MINUTES_MIN as functionsDetourMinutesMin,
  ORIGIN_ADDRESS as functionsOriginAddress,
  setJourneyOriginInputSchema as functionsOriginSchema,
} from '../functions/src/journeys';
import {
  GEOCODE_DECIMALS as functionsRouteDecimals,
  ROUTE_LIMITS as functionsRouteLimits,
  ROUTE_PROFILES as functionsRouteProfiles,
  ROUTE_STOPS_MAX as functionsStopsMax,
  ROUTE_STOPS_MIN as functionsStopsMin,
  calculateRouteInputSchema as functionsRouteSchema,
  roundStopsForRouting as functionsRoundStops,
} from '../functions/src/routing';
import {
  GEOCODE_DECIMALS as functionsGeocodeDecimals,
  GEOCODE_LIMITS as functionsGeocodeLimits,
  geocodeCacheKey as functionsCacheKey,
  reverseGeocodeInputSchema as functionsGeocodeSchema,
  roundForGeocoding as functionsRound,
} from '../functions/src/geocoding';
import {
  LOCATION_THROTTLE as functionsThrottle,
  isUsableAccuracy as functionsIsUsableAccuracy,
  updateDriverLocationInputSchema as functionsLocationSchema,
} from '../functions/src/locations';
import {
  AVAILABILITY_TARGETS as functionsAvailabilityTargets,
  GO_ONLINE_REQUIREMENTS as functionsRequirements,
  SET_AVAILABILITY_REFUSALS as functionsAvailabilityRefusals,
  evaluateGoOnline as functionsEvaluate,
  setAvailabilityInputSchema as functionsAvailabilitySchema,
} from '../functions/src/availability';
import {
  REVIEWER_ROLES as functionsReviewerRoles,
  REVIEW_DECISIONS as functionsDecisions,
  REVIEW_REASON_MAX_LENGTH as functionsReasonMax,
  REVIEW_TARGETS as functionsTargets,
  requestReviewInputSchema as functionsRequestSchema,
  reviewInputSchema as functionsReviewSchema,
} from '../functions/src/verification';
import {
  NEW_VEHICLE_DEFAULTS as functionsVehicleDefaults,
  VEHICLE_TYPES as functionsVehicleTypes,
  isValidPlate as functionsIsValidPlate,
  normalizePlate as functionsNormalizePlate,
  SEAT_CAPACITY_MAX as functionsSeatMax,
  SEAT_CAPACITY_MIN as functionsSeatMin,
  saveVehicleInputSchema as functionsVehicleSchema,
  setVehicleCapacityInputSchema as functionsCapacitySchema,
} from '../functions/src/vehicles';
import {
  NEW_JOURNEY_DEFAULTS,
  declareDestinationInputSchema as sharedDestinationSchema,
  setJourneySeatsInputSchema as sharedSeatsSchema,
  setJourneyDetourInputSchema as sharedDetourSchema,
  DETOUR_DISTANCE_KM_MAX,
  DETOUR_DISTANCE_KM_MIN,
  DETOUR_MINUTES_MAX,
  DETOUR_MINUTES_MIN,
  GEOCODE_DECIMALS,
  GEOCODE_LIMITS,
  ROUTE_LIMITS,
  ROUTE_PROFILES,
  ROUTE_STOPS_MAX,
  ROUTE_STOPS_MIN,
  calculateRouteInputSchema as sharedRouteSchema,
  roundStopsForRouting,
  geocodeCacheKey,
  reverseGeocodeInputSchema as sharedGeocodeSchema,
  roundForGeocoding,
  LOCATION_THROTTLE,
  ORIGIN_ADDRESS,
  isUsableAccuracy,
  setJourneyOriginInputSchema as sharedOriginSchema,
  updateDriverLocationInputSchema as sharedLocationSchema,
  AVAILABILITY_TARGETS,
  GO_ONLINE_REQUIREMENTS,
  SET_AVAILABILITY_REFUSALS,
  evaluateGoOnline,
  setAvailabilityInputSchema as sharedAvailabilitySchema,
  DRIVER_AVAILABILITY_STATUSES,
  DRIVER_VERIFICATION_STATUSES,
  NEW_DRIVER_PROFILE_DEFAULTS,
  NEW_VEHICLE_DEFAULTS,
  VEHICLE_TYPES,
  VEHICLE_VERIFICATION_STATUSES,
  isValidPlate,
  REVIEWER_ROLES,
  REVIEW_DECISIONS,
  REVIEW_REASON_MAX_LENGTH,
  REVIEW_TARGETS,
  SEAT_CAPACITY_MAX,
  SEAT_CAPACITY_MIN,
  requestReviewInputSchema as sharedRequestSchema,
  reviewInputSchema as sharedReviewSchema,
  normalizePlate,
  saveVehicleInputSchema as sharedVehicleSchema,
  setVehicleCapacityInputSchema as sharedCapacitySchema,
  SELF_SERVICE_ROLES,
  STAFF_ROLES,
  USER_ROLES,
  USER_STATUSES,
} from '@ridemesh/types';
import { describe, expect, it } from 'vitest';
import { completeRegistrationInputSchema as functionsSchema } from '../functions/src/registration';
import { completeRegistrationInputSchema as sharedSchema } from '@ridemesh/types';
import {
  FLEXIBILITY_LEVEL_LIMITS as functionsLevelLimits,
  MAX_AHEAD_DAYS as functionsMaxAheadDays,
  MIN_ARRIVAL_GAP_MINUTES as functionsMinArrivalGap,
  MIN_LEAD_MINUTES as functionsMinLead,
  NEW_TRIP_REQUEST_DEFAULTS as functionsTripDefaults,
  OPEN_TRIP_STATUSES as functionsOpenStatuses,
  PASSENGER_CANCELLABLE_STATUSES as functionsCancellable,
  TRIP_STATUS_TRANSITIONS as functionsTransitions,
  canPassengerCancel as functionsCanPassengerCancel,
  canTransition as functionsCanTransition,
  SAME_PLACE_DISTANCE_METERS as functionsSamePlaceMeters,
  TRIP_REQUEST_REFUSALS as functionsRefusals,
  cancelTripRequestInputSchema as functionsCancelSchema,
  checkTripTimes as functionsCheckTimes,
  createTripRequestInputSchema as functionsCreateSchema,
  isSamePlace as functionsIsSamePlace,
  isUsablePlace as functionsIsUsablePlace,
  isValidFlexibilityPreferences as functionsIsValidPreferences,
} from '../functions/src/tripRequests';
import {
  TRIP_EXECUTION_REFUSALS as functionsExecutionRefusals,
  advanceTripInputSchema as functionsAdvanceSchema,
} from '../functions/src/tripExecution';
import {
  FLEXIBILITY_LEVEL_LIMITS,
  MAX_AHEAD_DAYS,
  MIN_ARRIVAL_GAP_MINUTES,
  MIN_LEAD_MINUTES,
  NEW_TRIP_REQUEST_DEFAULTS,
  OPEN_TRIP_STATUSES,
  PASSENGER_CANCELLABLE_STATUSES,
  TRIP_STATUS_TRANSITIONS,
  canPassengerCancel,
  canTransition,
  SAME_PLACE_DISTANCE_METERS,
  TRIP_REQUEST_REFUSALS,
  cancelTripRequestInputSchema as sharedCancelSchema,
  checkTripTimes as sharedCheckTimes,
  createTripRequestInputSchema as sharedCreateSchema,
  findPlaceProblem,
  flexibilityPreferences,
  isSamePlace as sharedIsSamePlace,
  isValidFlexibilityPreferences as sharedIsValidPreferences,
  TRIP_REQUEST_STATUSES,
  TRIP_EXECUTION_REFUSALS,
  advanceTripInputSchema as sharedAdvanceSchema,
} from '@ridemesh/types';

describe('functions and shared types stay aligned', () => {
  it('uses the same role lists', () => {
    expect([...functionsSelfService]).toEqual([...SELF_SERVICE_ROLES]);
    expect([...functionsStaff]).toEqual([...STAFF_ROLES]);
    expect([...SELF_SERVICE_ROLES, ...STAFF_ROLES].sort()).toEqual([...USER_ROLES].sort());
  });

  it('uses the same user statuses', () => {
    expect([...functionsStatuses]).toEqual([...USER_STATUSES]);
  });

  it('validates registration input identically', () => {
    const samples: unknown[] = [
      { role: 'PASSENGER', name: 'Ada' },
      { role: 'DRIVER', name: ' Ada ', phone: '+441234' },
      { role: 'ADMIN', name: 'Ada' },
      { role: 'DRIVER', name: '' },
      { role: 'DRIVER', name: 'Ada', phone: '' },
      {},
    ];
    for (const sample of samples) {
      expect(functionsSchema.safeParse(sample).success).toBe(
        sharedSchema.safeParse(sample).success,
      );
    }
  });

  it('starts a new driver profile with the same values', () => {
    expect(functionsDriverDefaults).toEqual(NEW_DRIVER_PROFILE_DEFAULTS);
  });

  it('starts a new driver profile in states the shared types allow', () => {
    expect(DRIVER_VERIFICATION_STATUSES).toContain(functionsDriverDefaults.verificationStatus);
    expect(DRIVER_AVAILABILITY_STATUSES).toContain(functionsDriverDefaults.availabilityStatus);
  });

  it('uses the same vehicle types, defaults and starting status', () => {
    expect([...functionsVehicleTypes]).toEqual([...VEHICLE_TYPES]);
    expect(functionsVehicleDefaults).toEqual(NEW_VEHICLE_DEFAULTS);
    expect(VEHICLE_VERIFICATION_STATUSES).toContain(functionsVehicleDefaults.verificationStatus);
  });

  it('validates vehicle input and plates identically', () => {
    const inputs: unknown[] = [
      { type: 'CAR', make: 'Toyota', model: 'Corolla', plateNumber: 'ABC-123' },
      { type: 'BUS', make: 'Toyota', model: 'Corolla', plateNumber: 'ABC-123' },
      { type: 'VAN', make: '  ', model: 'Transit', plateNumber: 'AB 12' },
      { type: 'MINIBUS', make: 'x'.repeat(51), model: 'Y', plateNumber: 'AB 12' },
      { type: 'CAR', make: 'A', model: 'B', plateNumber: 'x'.repeat(21) },
      { type: 'CAR', make: 'A', model: 'B' },
      {},
    ];
    for (const input of inputs) {
      expect(functionsVehicleSchema.safeParse(input).success).toBe(
        sharedVehicleSchema.safeParse(input).success,
      );
    }

    const plates = [
      'ABC-123',
      ' ab  12 cd ',
      'A',
      'AB#1',
      '- -',
      'ABCDEFGHIJKLM',
      'ab-12',
      '',
      'é12',
    ];
    for (const plate of plates) {
      expect(functionsNormalizePlate(plate)).toEqual(normalizePlate(plate));
      expect(functionsIsValidPlate(functionsNormalizePlate(plate))).toBe(
        isValidPlate(normalizePlate(plate)),
      );
    }
  });

  it('validates seat capacity identically', () => {
    expect([functionsSeatMin, functionsSeatMax]).toEqual([SEAT_CAPACITY_MIN, SEAT_CAPACITY_MAX]);
    const inputs: unknown[] = [
      { seatCapacity: 1 },
      { seatCapacity: 6 },
      { seatCapacity: 0 },
      { seatCapacity: 7 },
      { seatCapacity: 2.5 },
      { seatCapacity: '4' },
      { seatCapacity: null },
      { seatCapacity: Number.NaN },
      {},
    ];
    for (const input of inputs) {
      expect(functionsCapacitySchema.safeParse(input).success).toBe(
        sharedCapacitySchema.safeParse(input).success,
      );
    }
  });

  it('uses the same reviewers, decisions and targets', () => {
    expect([...functionsReviewerRoles]).toEqual([...REVIEWER_ROLES]);
    expect([...functionsDecisions]).toEqual([...REVIEW_DECISIONS]);
    expect([...functionsTargets]).toEqual([...REVIEW_TARGETS]);
    expect(functionsReasonMax).toBe(REVIEW_REASON_MAX_LENGTH);
    // Only staff roles can review, and only the top two.
    for (const role of REVIEWER_ROLES) expect(STAFF_ROLES).toContain(role);
  });

  it('validates reviews and review requests identically', () => {
    const reviews: unknown[] = [
      { driverId: 'abc123', decision: 'VERIFIED' },
      { driverId: 'abc123', decision: 'VERIFIED', reason: null },
      { driverId: 'abc123', decision: 'VERIFIED', reason: 'ok' },
      { driverId: 'abc123', decision: 'REJECTED', reason: 'No.' },
      { driverId: 'abc123', decision: 'REJECTED' },
      { driverId: 'abc123', decision: 'REJECTED', reason: null },
      { driverId: 'abc123', decision: 'REJECTED', reason: '   ' },
      { driverId: 'abc123', decision: 'REJECTED', reason: 'x'.repeat(500) },
      { driverId: 'abc123', decision: 'REJECTED', reason: 'x'.repeat(501) },
      { driverId: 'abc123', decision: 'PENDING' },
      { driverId: 'users/abc', decision: 'VERIFIED' },
      { driverId: '..', decision: 'VERIFIED' },
      { driverId: '', decision: 'VERIFIED' },
      { driverId: 'a'.repeat(129), decision: 'VERIFIED' },
      { decision: 'VERIFIED' },
      {},
    ];
    for (const input of reviews) {
      expect(functionsReviewSchema.safeParse(input).success).toBe(
        sharedReviewSchema.safeParse(input).success,
      );
    }
    const requests: unknown[] = [{ target: 'DRIVER' }, { target: 'VEHICLE' }, { target: 'x' }, {}];
    for (const input of requests) {
      expect(functionsRequestSchema.safeParse(input).success).toBe(
        sharedRequestSchema.safeParse(input).success,
      );
    }
  });

  it('uses the same availability targets and go-online requirements', () => {
    expect([...functionsAvailabilityTargets]).toEqual([...AVAILABILITY_TARGETS]);
    expect([...AVAILABILITY_TARGETS].sort()).toEqual([...DRIVER_AVAILABILITY_STATUSES].sort());
    expect([...functionsRequirements]).toEqual([...GO_ONLINE_REQUIREMENTS]);
    expect([...functionsAvailabilityRefusals]).toEqual([...SET_AVAILABILITY_REFUSALS]);
    for (const input of [
      { status: 'ONLINE' },
      { status: 'OFFLINE' },
      { status: 'BUSY' },
      {},
      { status: null },
    ]) {
      expect(functionsAvailabilitySchema.safeParse(input).success).toBe(
        sharedAvailabilitySchema.safeParse(input).success,
      );
    }
  });

  it('decides who may go online identically, over every combination', () => {
    const statuses = ['PENDING', 'VERIFIED', 'REJECTED', null] as const;
    for (const accountActive of [true, false]) {
      for (const driverStatus of statuses) {
        for (const vehicleStatus of statuses) {
          for (const seatCapacity of [null, 1, 4]) {
            for (const destinationDeclared of [true, false]) {
              for (const originSet of [true, false]) {
                for (const availableSeats of [null, 0, 1, 2.5, 4, 5]) {
                  for (const maxDetourMinutes of [null, 0, 1, 7.5, 60, 61]) {
                    for (const maxDetourDistance of [null, 0, 1, 2.5, 30, 31]) {
                      const facts = {
                        accountActive,
                        driverStatus,
                        vehicleStatus,
                        seatCapacity,
                        destinationDeclared,
                        originSet,
                        availableSeats,
                        maxDetourMinutes,
                        maxDetourDistance,
                      };
                      const shared = evaluateGoOnline(facts);
                      const server = functionsEvaluate(facts);
                      expect(server.eligible).toBe(shared.eligible);
                      expect(server.unmet).toEqual(
                        shared.checks
                          .filter((check) => !check.met)
                          .map((check) => check.requirement),
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it('starts a new journey the same way, and validates destinations identically', () => {
    expect(functionsJourneyDefaults).toEqual(NEW_JOURNEY_DEFAULTS);
    const place = { latitude: 51.5, longitude: -0.02, formattedAddress: 'Office', placeId: 'p1' };
    const inputs: unknown[] = [
      { destination: place },
      { destination: { ...place, placeId: null } },
      { destination: { ...place, placeId: undefined } },
      { destination: { ...place, placeId: '' } },
      { destination: { ...place, latitude: 91 } },
      { destination: { ...place, longitude: -181 } },
      { destination: { ...place, latitude: '51' } },
      { destination: { ...place, formattedAddress: '  ' } },
      { destination: { ...place, formattedAddress: 'x'.repeat(300) } },
      { destination: { ...place, formattedAddress: 'x'.repeat(301) } },
      { destination: { ...place, placeId: 'x'.repeat(301) } },
      { destination: null },
      place,
      {},
    ];
    for (const input of inputs) {
      expect(functionsDestinationSchema.safeParse(input).success).toBe(
        sharedDestinationSchema.safeParse(input).success,
      );
    }
  });

  it('validates the seats on offer identically', () => {
    const inputs: unknown[] = [
      ...[0, 1, 2, 3, 4, 5, 6, 7, -1, 2.5, Number.NaN].map((availableSeats) => ({
        availableSeats,
      })),
      { availableSeats: '3' },
      { availableSeats: null },
      {},
    ];
    for (const input of inputs) {
      expect(functionsSeatsSchema.safeParse(input).success).toBe(
        sharedSeatsSchema.safeParse(input).success,
      );
    }
  });

  it('validates the detour limits identically, with the same ranges', () => {
    expect([
      functionsDetourMinutesMin,
      functionsDetourMinutesMax,
      functionsDetourKmMin,
      functionsDetourKmMax,
    ]).toEqual([
      DETOUR_MINUTES_MIN,
      DETOUR_MINUTES_MAX,
      DETOUR_DISTANCE_KM_MIN,
      DETOUR_DISTANCE_KM_MAX,
    ]);
    const values = [0, 1, 2, 5, 7.5, 30, 31, 60, 61, -1, Number.NaN, '5', null, undefined];
    for (const maxDetourMinutes of values) {
      for (const maxDetourDistance of values) {
        const input = { maxDetourMinutes, maxDetourDistance };
        expect(functionsDetourSchema.safeParse(input).success).toBe(
          sharedDetourSchema.safeParse(input).success,
        );
      }
    }
    expect(functionsDetourSchema.safeParse({}).success).toBe(false);
  });
});

describe('trip requests: functions and shared types stay aligned', () => {
  const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
  const MIN = 60_000;
  const place = (overrides: Record<string, unknown> = {}) => ({
    latitude: 51.5,
    longitude: -0.02,
    formattedAddress: 'Office',
    placeId: 'p1',
    ...overrides,
  });
  const balanced = flexibilityPreferences({
    level: 'BALANCED',
    allowSharedRide: true,
    allowRouteChange: true,
  });
  const valid = () => ({
    origin: place(),
    destination: place({ latitude: 51.6, placeId: 'p2', formattedAddress: 'Home' }),
    departure: { kind: 'NOW' },
    arriveBy: null,
    preferences: balanced,
  });

  it('uses the same statuses, refusals, defaults and limits', () => {
    expect([...functionsOpenStatuses]).toEqual([...OPEN_TRIP_STATUSES]);
    for (const status of OPEN_TRIP_STATUSES) expect(TRIP_REQUEST_STATUSES).toContain(status);
    expect([...functionsRefusals]).toEqual([...TRIP_REQUEST_REFUSALS]);
    expect([...functionsExecutionRefusals]).toEqual([...TRIP_EXECUTION_REFUSALS]);
    expect(functionsTripDefaults).toEqual(NEW_TRIP_REQUEST_DEFAULTS);
    expect(TRIP_REQUEST_STATUSES).toContain(functionsTripDefaults.status);
    expect([
      functionsSamePlaceMeters,
      functionsMinLead,
      functionsMaxAheadDays,
      functionsMinArrivalGap,
    ]).toEqual([
      SAME_PLACE_DISTANCE_METERS,
      MIN_LEAD_MINUTES,
      MAX_AHEAD_DAYS,
      MIN_ARRIVAL_GAP_MINUTES,
    ]);
    for (const level of ['STRICT', 'BALANCED', 'FLEXIBLE'] as const) {
      const { maxWalkingDistance, maxExtraTime, maxDetourDistance } =
        FLEXIBILITY_LEVEL_LIMITS[level];
      expect(functionsLevelLimits[level]).toEqual({
        maxWalkingDistance,
        maxExtraTime,
        maxDetourDistance,
      });
    }
  });

  it('validates the input of a request identically', () => {
    const inputs: unknown[] = [
      valid(),
      { ...valid(), departure: { kind: 'AT', at: NOW + 30 * MIN } },
      { ...valid(), departure: { kind: 'AT', at: Number.NaN } },
      { ...valid(), departure: { kind: 'AT' } },
      { ...valid(), departure: { kind: 'LATER' } },
      { ...valid(), arriveBy: NOW + 60 * MIN },
      { ...valid(), arriveBy: undefined },
      { ...valid(), arriveBy: '1' },
      { ...valid(), origin: place({ latitude: 91 }) },
      { ...valid(), destination: place({ formattedAddress: '  ' }) },
      { ...valid(), destination: null },
      { ...valid(), preferences: { ...balanced, flexibilityLevel: 'WILD' } },
      { ...valid(), preferences: { ...balanced, maxWalkingDistance: 0 } },
      { ...valid(), preferences: { ...balanced, allowSharedRide: 'yes' } },
      { origin: place() },
      {},
    ];
    for (const input of inputs) {
      expect(functionsCreateSchema.safeParse(input).success).toBe(
        sharedCreateSchema.safeParse(input).success,
      );
    }
    for (const input of [{ tripId: 'abc' }, { tripId: '' }, { tripId: 'x'.repeat(201) }, {}]) {
      expect(functionsCancelSchema.safeParse(input).success).toBe(
        sharedCancelSchema.safeParse(input).success,
      );
      expect(functionsAdvanceSchema.safeParse(input).success).toBe(
        sharedAdvanceSchema.safeParse(input).success,
      );
    }
  });

  it('decides the same place identically', () => {
    const base = place({ placeId: null });
    const places = [
      base,
      place({ placeId: 'p1' }),
      place({ placeId: 'p1', latitude: 40 }),
      place({ placeId: 'p2', latitude: 40 }),
      place({ placeId: null, latitude: 51.5004 }),
      place({ placeId: null, latitude: 51.5006 }),
      place({ placeId: null, latitude: 51.5, longitude: -0.0206 }),
    ].map((entry) => ({ ...entry, placeId: (entry.placeId ?? null) as string | null }));
    for (const a of places) {
      for (const b of places) {
        expect(functionsIsSamePlace(a, b)).toBe(sharedIsSamePlace(a, b));
      }
    }
  });

  it('treats 0, 0 as no position, as the shared check does', () => {
    for (const [latitude, longitude] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [51.5, -0.02],
    ] as const) {
      const candidate = place({ latitude, longitude, placeId: null }) as ReturnType<
        typeof place
      > & {
        placeId: string | null;
      };
      expect(functionsIsUsablePlace(candidate)).toBe(findPlaceProblem(candidate) === null);
    }
  });

  it('checks the times identically, at every edge', () => {
    const departures = [
      { kind: 'NOW' as const },
      ...[-1, 0, 4, 5, 6, 60, 7 * 24 * 60 - 1, 7 * 24 * 60, 7 * 24 * 60 + 1].map((minutes) => ({
        kind: 'AT' as const,
        at: NOW + minutes * MIN,
      })),
      { kind: 'AT' as const, at: Number.NaN },
      { kind: 'AT' as const, at: Number.POSITIVE_INFINITY },
    ];
    const arrivals = [
      null,
      ...[-1, 0, 4, 5, 6, 30, 61, 7 * 24 * 60, 7 * 24 * 60 + 1].map(
        (minutes) => NOW + minutes * MIN,
      ),
      Number.NaN,
    ];
    for (const departure of departures) {
      for (const arriveBy of arrivals) {
        const times = { departure, arriveBy };
        expect(functionsCheckTimes(times, NOW)).toEqual(sharedCheckTimes(times, NOW));
      }
    }
  });

  it('accepts exactly the preferences a level gives, identically', () => {
    const cases: unknown[] = [
      ...(['STRICT', 'BALANCED', 'FLEXIBLE'] as const).flatMap((level) => [
        flexibilityPreferences({ level, allowSharedRide: true, allowRouteChange: true }),
        flexibilityPreferences({ level, allowSharedRide: false, allowRouteChange: false }),
      ]),
      { ...balanced, flexibilityLevel: 'STRICT' },
      { ...balanced, maxWalkingDistance: 5000 },
      { ...balanced, maxExtraTime: 11 },
      { ...balanced, maxDetourDistance: 4 },
      { ...balanced, maxWalkingDistance: 500.5 },
      { ...balanced, flexibilityLevel: 'WILD' },
      { ...balanced, allowRouteChange: 'no' },
      null,
      {},
    ];
    for (const value of cases) {
      expect(functionsIsValidPreferences(value)).toBe(sharedIsValidPreferences(value));
    }
  });

  it('allows the same status transitions, and the same cancellations, identically', () => {
    expect(functionsTransitions).toEqual(TRIP_STATUS_TRANSITIONS);
    expect([...functionsCancellable]).toEqual([...PASSENGER_CANCELLABLE_STATUSES]);
    const statuses: unknown[] = [...TRIP_REQUEST_STATUSES, 'DRAFT', 'requested', '', null, 7];
    for (const from of statuses) {
      expect(functionsCanPassengerCancel(from)).toBe(canPassengerCancel(from));
      for (const to of statuses) {
        expect(functionsCanTransition(from, to)).toBe(canTransition(from, to));
      }
    }
    // Names that exist on every object are not statuses.
    expect(functionsCanTransition('constructor', 'CANCELLED')).toBe(false);
    expect(functionsCanTransition('__proto__', 'CANCELLED')).toBe(false);
  });

  it('has a sound transition table: every status is covered, nothing leaves an end state', () => {
    expect(Object.keys(TRIP_STATUS_TRANSITIONS).sort()).toEqual([...TRIP_REQUEST_STATUSES].sort());
    for (const [from, targets] of Object.entries(TRIP_STATUS_TRANSITIONS)) {
      for (const to of targets) expect(TRIP_REQUEST_STATUSES).toContain(to);
      expect(targets).not.toContain(from);
    }
    expect(TRIP_STATUS_TRANSITIONS.COMPLETED).toEqual([]);
    expect(TRIP_STATUS_TRANSITIONS.CANCELLED).toEqual([]);
    // Every open status can reach an end state, and the open statuses are exactly the others.
    for (const status of OPEN_TRIP_STATUSES) {
      const seen = new Set<string>([status]);
      const queue: string[] = [status];
      while (queue.length > 0) {
        const next = TRIP_STATUS_TRANSITIONS[queue.shift() as keyof typeof TRIP_STATUS_TRANSITIONS];
        for (const target of next ?? []) {
          if (!seen.has(target)) {
            seen.add(target);
            queue.push(target);
          }
        }
      }
      expect(seen.has('COMPLETED') || seen.has('CANCELLED')).toBe(true);
    }
    for (const status of TRIP_REQUEST_STATUSES) {
      const ended = TRIP_STATUS_TRANSITIONS[status].length === 0;
      expect(ended).toBe(!(OPEN_TRIP_STATUSES as readonly string[]).includes(status));
    }
    // A passenger can cancel only where free cancellation is agreed, and only along an arrow.
    expect([...PASSENGER_CANCELLABLE_STATUSES]).toEqual(['REQUESTED', 'SEARCHING']);
    for (const status of TRIP_REQUEST_STATUSES) {
      expect(canPassengerCancel(status)).toBe(status === 'REQUESTED' || status === 'SEARCHING');
    }
  });
});

describe('driver location: functions and shared types stay aligned', () => {
  it('uses the same throttle numbers and origin label', () => {
    expect(functionsThrottle).toEqual(LOCATION_THROTTLE);
    expect(functionsOriginAddress).toBe(ORIGIN_ADDRESS);
    // The server's safety net is looser than the app's own rule.
    expect(functionsThrottle.serverMinIntervalMs).toBeLessThan(functionsThrottle.minIntervalMs);
  });

  it('validates the journey origin identically', () => {
    const inputs: unknown[] = [
      { origin: { latitude: 51.5, longitude: -0.1 } },
      { origin: { latitude: 51.5, longitude: -0.1 }, address: '1 Test Street, Bristol' },
      { origin: { latitude: 51.5, longitude: -0.1 }, address: null },
      { origin: { latitude: 51.5, longitude: -0.1 }, address: '   ' },
      { origin: { latitude: 51.5, longitude: -0.1 }, address: 'x'.repeat(300) },
      { origin: { latitude: 51.5, longitude: -0.1 }, address: 'x'.repeat(301) },
      { origin: { latitude: 51.5, longitude: -0.1 }, address: 5 },
      { origin: { latitude: 0, longitude: 0 } },
      { origin: { latitude: 0, longitude: 5 } },
      { origin: { latitude: 5, longitude: 0 } },
      { origin: { latitude: 90, longitude: 180 } },
      { origin: { latitude: -90.1, longitude: 0 } },
      { origin: { latitude: 0, longitude: 180.1 } },
      { origin: { latitude: '51', longitude: 0 } },
      { origin: { latitude: Number.NaN, longitude: 0 } },
      { origin: { latitude: 51.5 } },
      { origin: null },
      { latitude: 51.5, longitude: -0.1 },
      {},
    ];
    for (const input of inputs) {
      expect(functionsOriginSchema.safeParse(input).success).toBe(
        sharedOriginSchema.safeParse(input).success,
      );
    }
  });

  it('validates a location reading and its accuracy identically', () => {
    const readings: unknown[] = [
      { latitude: 51.5, longitude: -0.1 },
      { latitude: 51.5, longitude: -0.1, accuracy: 0 },
      { latitude: 51.5, longitude: -0.1, accuracy: 100 },
      { latitude: 51.5, longitude: -0.1, accuracy: 100.5 },
      { latitude: 51.5, longitude: -0.1, accuracy: 1_000_000 },
      { latitude: 51.5, longitude: -0.1, accuracy: 1_000_001 },
      { latitude: 51.5, longitude: -0.1, accuracy: -1 },
      { latitude: 51.5, longitude: -0.1, accuracy: null },
      { latitude: 51.5, longitude: -0.1, accuracy: '5' },
      { latitude: 0, longitude: 0, accuracy: 5 },
      { latitude: 91, longitude: 0 },
      { latitude: 0 },
      null,
      {},
    ];
    for (const reading of readings) {
      expect(functionsLocationSchema.safeParse(reading).success).toBe(
        sharedLocationSchema.safeParse(reading).success,
      );
    }
    for (const accuracy of [
      0,
      1,
      99.9,
      100,
      100.1,
      500,
      -1,
      Number.NaN,
      Infinity,
      null,
      undefined,
    ]) {
      expect(functionsIsUsableAccuracy(accuracy)).toBe(isUsableAccuracy(accuracy));
    }
  });
});

describe('reverse geocoding: functions and shared types stay aligned', () => {
  it('uses the same rounding and limits', () => {
    expect(functionsGeocodeDecimals).toBe(GEOCODE_DECIMALS);
    expect(functionsGeocodeLimits).toEqual(GEOCODE_LIMITS);
  });

  it('rounds and keys positions identically, including the awkward ones', () => {
    const values = [
      0, -0, 0.00001, -0.00001, 0.00005, -0.00005, 51.44941, 51.44945, 51.44946, -2.58135, -2.58136,
      89.99995, -89.99995, 179.99996, -179.99996, 12.3456789, 1e-9,
    ];
    for (const latitude of values) {
      for (const longitude of values) {
        const point = { latitude, longitude };
        expect(functionsRound(point)).toEqual(roundForGeocoding(point));
        expect(functionsCacheKey(point)).toBe(geocodeCacheKey(point));
      }
    }
  });

  it('validates a position identically', () => {
    const inputs: unknown[] = [
      { latitude: 51.5, longitude: -0.1 },
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 5 },
      { latitude: 90, longitude: 180 },
      { latitude: 90.0001, longitude: 0 },
      { latitude: 0, longitude: -180.0001 },
      { latitude: '51', longitude: 0 },
      { latitude: Number.NaN, longitude: 0 },
      { latitude: Infinity, longitude: 0 },
      { latitude: 51 },
      null,
      {},
    ];
    for (const input of inputs) {
      expect(functionsGeocodeSchema.safeParse(input).success).toBe(
        sharedGeocodeSchema.safeParse(input).success,
      );
    }
  });
});

describe('route calculation: functions and shared types stay aligned', () => {
  it('uses the same numbers, profiles and rounding', () => {
    expect(functionsRouteDecimals).toBe(GEOCODE_DECIMALS);
    expect([functionsStopsMin, functionsStopsMax]).toEqual([ROUTE_STOPS_MIN, ROUTE_STOPS_MAX]);
    expect([...functionsRouteProfiles]).toEqual([...ROUTE_PROFILES]);
    expect(functionsRouteLimits).toEqual(ROUTE_LIMITS);
    // Routes are asked for through the same rounding as addresses (about 11 m).
    expect(functionsRouteLimits.globalSpacingMs).toBe(GEOCODE_LIMITS.globalSpacingMs);
  });

  it('rounds the stops identically, including the awkward ones', () => {
    const values = [
      0, -0, 0.00001, -0.00001, 51.44945, 51.44946, -2.58135, -2.58136, 89.99995, 179.99996,
    ];
    for (const latitude of values) {
      for (const longitude of values) {
        const stops = [
          { latitude, longitude },
          { latitude: longitude, longitude: latitude },
        ];
        expect(functionsRoundStops(stops)).toEqual(roundStopsForRouting(stops));
      }
    }
  });

  it('validates a route request identically', () => {
    const stop = (n: number) => ({ latitude: 51 + n * 0.01, longitude: -2 + n * 0.01 });
    const stops = (count: number) => Array.from({ length: count }, (_unused, n) => stop(n));
    const inputs: unknown[] = [
      { stops: stops(0) },
      { stops: stops(1) },
      { stops: stops(2) },
      { stops: stops(10) },
      { stops: stops(11) },
      { stops: stops(2), profile: 'driving' },
      { stops: stops(2), profile: null },
      { stops: stops(2), profile: undefined },
      { stops: stops(2), profile: 'walking' },
      { stops: stops(2), profile: 'cycling' },
      { stops: stops(2), profile: 'foot' },
      { stops: stops(2), profile: 'WALKING' },
      { stops: [stop(0), { latitude: 0, longitude: 0 }] },
      { stops: [stop(0), { latitude: 0, longitude: 5 }] },
      { stops: [stop(0), { latitude: 91, longitude: 0 }] },
      { stops: [stop(0), { latitude: 0, longitude: -181 }] },
      { stops: [stop(0), { latitude: '51', longitude: 0 }] },
      { stops: [stop(0), { latitude: Number.NaN, longitude: 0 }] },
      { stops: [stop(0), { latitude: Infinity, longitude: 0 }] },
      { stops: [stop(0), null] },
      { stops: 'abc' },
      { stops: {} },
      null,
      {},
    ];
    for (const input of inputs) {
      expect(functionsRouteSchema.safeParse(input).success).toBe(
        sharedRouteSchema.safeParse(input).success,
      );
    }
  });
});
