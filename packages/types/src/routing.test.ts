import { describe, expect, it } from 'vitest';
import {
  ROUTE_LIMITS,
  ROUTE_PROFILES,
  ROUTE_STOPS_MAX,
  ROUTE_STOPS_MIN,
  calculateRouteInputSchema,
  roundStopsForRouting,
} from './routing';

const stop = (n: number) => ({ latitude: 51 + n * 0.01, longitude: -2 + n * 0.01 });
const stops = (count: number) => Array.from({ length: count }, (_unused, n) => stop(n));

describe('route input', () => {
  const ok = (input: unknown) => calculateRouteInputSchema.safeParse(input).success;

  it('needs 2 to 10 stops', () => {
    expect([ROUTE_STOPS_MIN, ROUTE_STOPS_MAX]).toEqual([2, 10]);
    expect(ok({ stops: stops(0) })).toBe(false);
    expect(ok({ stops: stops(1) })).toBe(false);
    expect(ok({ stops: stops(2) })).toBe(true);
    expect(ok({ stops: stops(10) })).toBe(true);
    expect(ok({ stops: stops(11) })).toBe(false);
  });

  it('refuses a stop that is not a real position', () => {
    expect(ok({ stops: [stop(0), { latitude: 0, longitude: 0 }] })).toBe(false);
    expect(ok({ stops: [stop(0), { latitude: 0, longitude: 5 }] })).toBe(true);
    expect(ok({ stops: [stop(0), { latitude: 91, longitude: 0 }] })).toBe(false);
    expect(ok({ stops: [stop(0), { latitude: 0, longitude: -181 }] })).toBe(false);
    expect(ok({ stops: [stop(0), { latitude: '51', longitude: 0 }] })).toBe(false);
    expect(ok({ stops: [stop(0), { latitude: Number.NaN, longitude: 0 }] })).toBe(false);
    expect(ok({ stops: [stop(0), { latitude: 51 }] })).toBe(false);
    expect(ok({ stops: [stop(0), null] })).toBe(false);
  });

  it('takes a profile, driving being the only one for now, or none', () => {
    expect([...ROUTE_PROFILES]).toEqual(['driving']);
    expect(ok({ stops: stops(2), profile: 'driving' })).toBe(true);
    expect(ok({ stops: stops(2), profile: null })).toBe(true);
    expect(ok({ stops: stops(2), profile: undefined })).toBe(true);
    expect(ok({ stops: stops(2), profile: 'walking' })).toBe(false);
    expect(ok({ stops: stops(2), profile: 'flying' })).toBe(false);
  });

  it('refuses anything that is not a list of stops', () => {
    expect(ok({})).toBe(false);
    expect(ok(null)).toBe(false);
    expect(ok({ stops: 'abc' })).toBe(false);
    expect(ok({ stops: { 0: stop(0), 1: stop(1), length: 2 } })).toBe(false);
  });
});

describe('the limits', () => {
  it('spare the public server, cap one person, and refuse a stop far from any road', () => {
    expect(ROUTE_LIMITS.globalSpacingMs).toBeGreaterThan(1_000);
    expect(ROUTE_LIMITS.perCallerPerMinute).toBe(20);
    expect(ROUTE_LIMITS.providerTimeoutMs).toBe(8_000);
    expect(ROUTE_LIMITS.maxSnapMeters).toBe(1_000);
  });
});

describe('rounding the stops', () => {
  it('rounds every stop, in order, and leaves the original alone', () => {
    const original = [
      { latitude: 51.44941234, longitude: -2.58139876 },
      { latitude: 51.50494321, longitude: -0.01949999 },
    ];
    const rounded = roundStopsForRouting(original);
    expect(rounded).toEqual([
      { latitude: 51.4494, longitude: -2.5814 },
      { latitude: 51.5049, longitude: -0.0195 },
    ]);
    expect(original[0]?.latitude).toBe(51.44941234);
  });
});
