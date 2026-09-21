import { describe, expect, it } from 'vitest';
import { CURRENT_LOCATION_ADDRESS, currentLocationPlace } from './trip';
import {
  GEOCODE_DECIMALS,
  GEOCODE_LIMITS,
  geocodeCacheKey,
  reverseGeocodeInputSchema,
  roundForGeocoding,
} from './geocoding';
import { setJourneyOriginInputSchema } from './gps';

describe('rounding a position before it is sent', () => {
  it('rounds to 4 decimals, about 11 metres', () => {
    expect(GEOCODE_DECIMALS).toBe(4);
    expect(roundForGeocoding({ latitude: 51.449412, longitude: -2.581349 })).toEqual({
      latitude: 51.4494,
      longitude: -2.5813,
    });
    expect(roundForGeocoding({ latitude: 51.44996, longitude: -2.58136 })).toEqual({
      latitude: 51.45,
      longitude: -2.5814,
    });
  });

  it('never gives the exact position back', () => {
    const exact = { latitude: 51.4494123456, longitude: -2.5813987654 };
    const rounded = roundForGeocoding(exact);
    expect(rounded).not.toEqual(exact);
    // At most 4 decimals: what follows the fourth is gone.
    for (const value of [rounded.latitude, rounded.longitude]) {
      expect(String(value).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(4);
    }
  });

  it('moves a position by less than 8 metres at most', () => {
    // Half of 0.0001 degrees of latitude is 5.6 m, and of longitude at 51 degrees about 3.5 m.
    for (let i = 0; i < 200; i += 1) {
      const point = { latitude: 51 + Math.sin(i) / 10, longitude: -2 + Math.cos(i) / 10 };
      const rounded = roundForGeocoding(point);
      expect(Math.abs(rounded.latitude - point.latitude)).toBeLessThanOrEqual(0.00005 + 1e-9);
      expect(Math.abs(rounded.longitude - point.longitude)).toBeLessThanOrEqual(0.00005 + 1e-9);
    }
  });

  it('treats a rounded -0 and 0 as the same place', () => {
    expect(roundForGeocoding({ latitude: -0.00001, longitude: 0.00001 })).toEqual({
      latitude: 0,
      longitude: 0,
    });
    expect(Object.is(roundForGeocoding({ latitude: -0.00001, longitude: 1 }).latitude, -0)).toBe(
      false,
    );
    expect(geocodeCacheKey({ latitude: -0.00001, longitude: 5 })).toBe(
      geocodeCacheKey({ latitude: 0.00001, longitude: 5 }),
    );
  });
});

describe('the cache key', () => {
  it('is the rounded position, and the same for positions that round to the same place', () => {
    expect(geocodeCacheKey({ latitude: 51.44941, longitude: -2.58131 })).toBe('51.4494_-2.5813');
    expect(geocodeCacheKey({ latitude: 51.44944, longitude: -2.58134 })).toBe('51.4494_-2.5813');
    expect(geocodeCacheKey({ latitude: 51.44946, longitude: -2.58134 })).toBe('51.4495_-2.5813');
  });

  it('is a valid Firestore document ID and holds nothing about who asked', () => {
    const key = geocodeCacheKey({ latitude: -33.8568, longitude: 151.2153 });
    expect(key).toBe('-33.8568_151.2153');
    expect(key).toMatch(/^[-0-9._]+$/);
    expect(key).not.toBe('.');
    expect(key).not.toBe('..');
    expect(key.length).toBeLessThan(40);
  });

  it('keeps trailing zeros, so 51.5 and 51.5000 are one key', () => {
    expect(geocodeCacheKey({ latitude: 51.5, longitude: -2 })).toBe('51.5000_-2.0000');
  });
});

describe('the limits', () => {
  it('keep to one request a second for everyone, and cap one caller', () => {
    expect(GEOCODE_LIMITS.globalSpacingMs).toBeGreaterThan(1_000);
    expect(GEOCODE_LIMITS.perCallerPerMinute).toBe(10);
    expect(GEOCODE_LIMITS.providerTimeoutMs).toBe(5_000);
  });
});

describe('input', () => {
  it('accepts a real position and refuses the rest', () => {
    const ok = (input: unknown) => reverseGeocodeInputSchema.safeParse(input).success;
    expect(ok({ latitude: 51.5, longitude: -0.1 })).toBe(true);
    expect(ok({ latitude: 0, longitude: 5 })).toBe(true);
    expect(ok({ latitude: 0, longitude: 0 })).toBe(false);
    expect(ok({ latitude: 91, longitude: 0 })).toBe(false);
    expect(ok({ latitude: 0, longitude: -181 })).toBe(false);
    expect(ok({ latitude: '51', longitude: 0 })).toBe(false);
    expect(ok({ latitude: Number.NaN, longitude: 0 })).toBe(false);
    expect(ok(null)).toBe(false);
    expect(ok({})).toBe(false);
  });

  it('lets a journey start carry an address, which is optional', () => {
    const origin = { latitude: 51.5, longitude: -0.1 };
    const ok = (input: unknown) => setJourneyOriginInputSchema.safeParse(input).success;
    expect(ok({ origin })).toBe(true);
    expect(ok({ origin, address: null })).toBe(true);
    expect(ok({ origin, address: '1 Test Street, Bristol' })).toBe(true);
    expect(ok({ origin, address: '   ' })).toBe(false);
    expect(ok({ origin, address: 'x'.repeat(300) })).toBe(true);
    expect(ok({ origin, address: 'x'.repeat(301) })).toBe(false);
    expect(ok({ origin, address: 5 })).toBe(false);
  });
});

describe('a pickup from the device', () => {
  const here = { latitude: 51.5, longitude: -0.1 };

  it('says "Current location" with no address, and uses the address when there is one', () => {
    expect(currentLocationPlace(here).formattedAddress).toBe(CURRENT_LOCATION_ADDRESS);
    expect(currentLocationPlace(here, null).formattedAddress).toBe(CURRENT_LOCATION_ADDRESS);
    expect(currentLocationPlace(here, '   ').formattedAddress).toBe(CURRENT_LOCATION_ADDRESS);
    expect(currentLocationPlace(here, ' 1 Test Street, Bristol ').formattedAddress).toBe(
      '1 Test Street, Bristol',
    );
  });

  it('keeps the exact coordinates and never a place ID, whatever the address', () => {
    expect(currentLocationPlace(here, '1 Test Street')).toEqual({
      latitude: 51.5,
      longitude: -0.1,
      formattedAddress: '1 Test Street',
      placeId: null,
    });
  });

  it('never makes an address longer than a place may have', () => {
    expect(currentLocationPlace(here, 'x'.repeat(500)).formattedAddress).toHaveLength(300);
  });
});
