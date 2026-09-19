import { describe, expect, it } from 'vitest';
import {
  DRIVER_JOURNEY_STATUSES,
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
