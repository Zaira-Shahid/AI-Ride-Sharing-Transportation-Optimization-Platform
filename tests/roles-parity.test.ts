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
} from '../functions/src/journeys';
import {
  AVAILABILITY_TARGETS as functionsAvailabilityTargets,
  GO_ONLINE_REQUIREMENTS as functionsRequirements,
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
  AVAILABILITY_TARGETS,
  GO_ONLINE_REQUIREMENTS,
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
              for (const availableSeats of [null, 0, 1, 2.5, 4, 5]) {
                for (const maxDetourMinutes of [null, 0, 1, 7.5, 60, 61]) {
                  for (const maxDetourDistance of [null, 0, 1, 2.5, 30, 31]) {
                    const facts = {
                      accountActive,
                      driverStatus,
                      vehicleStatus,
                      seatCapacity,
                      destinationDeclared,
                      availableSeats,
                      maxDetourMinutes,
                      maxDetourDistance,
                    };
                    const shared = evaluateGoOnline(facts);
                    const server = functionsEvaluate(facts);
                    expect(server.eligible).toBe(shared.eligible);
                    expect(server.unmet).toEqual(
                      shared.checks.filter((check) => !check.met).map((check) => check.requirement),
                    );
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
