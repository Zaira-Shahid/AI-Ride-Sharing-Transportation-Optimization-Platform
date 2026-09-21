import { describe, expect, it } from 'vitest';
import {
  ESTIMATE_WAIT_MS,
  arrivalShortfallMinutes,
  describeEstimate,
  estimateProgress,
  formatDistance,
  formatDuration,
  readTripEstimate,
} from './trip-estimate';

describe('reading the estimate stored on a request', () => {
  it('needs both halves to be numbers', () => {
    expect(readTripEstimate(8200, 1080)).toEqual({ distanceMeters: 8200, durationSeconds: 1080 });
    expect(readTripEstimate(0, 0)).toEqual({ distanceMeters: 0, durationSeconds: 0 });
    expect(readTripEstimate(null, null)).toBeNull();
    expect(readTripEstimate(8200, null)).toBeNull();
    expect(readTripEstimate(null, 1080)).toBeNull();
    expect(readTripEstimate(undefined, undefined)).toBeNull();
  });

  it.each([['8200'], [Number.NaN], [Infinity], [-1], [{}], [[]]])('refuses %s as a half', (bad) => {
    expect(readTripEstimate(bad, 100)).toBeNull();
    expect(readTripEstimate(100, bad)).toBeNull();
  });
});

describe('where the estimate stands', () => {
  const estimate = { distanceMeters: 1000, durationSeconds: 100 };
  const T0 = 1_000_000;

  it('is ready as soon as there is one, whatever the time', () => {
    expect(estimateProgress({ estimate, requestedAt: T0 }, T0)).toBe('READY');
    expect(estimateProgress({ estimate, requestedAt: T0 }, T0 + 10 * ESTIMATE_WAIT_MS)).toBe(
      'READY',
    );
    expect(estimateProgress({ estimate, requestedAt: null }, T0)).toBe('READY');
  });

  it('waits for 30 seconds, and then says it is not available', () => {
    expect(ESTIMATE_WAIT_MS).toBe(30_000);
    expect(estimateProgress({ estimate: null, requestedAt: T0 }, T0)).toBe('WAITING');
    expect(estimateProgress({ estimate: null, requestedAt: T0 }, T0 + 29_999)).toBe('WAITING');
    expect(estimateProgress({ estimate: null, requestedAt: T0 }, T0 + 30_000)).toBe('UNAVAILABLE');
    expect(estimateProgress({ estimate: null, requestedAt: T0 }, T0 + 999_999)).toBe('UNAVAILABLE');
  });

  it('keeps waiting when it does not know when the request was made yet', () => {
    expect(estimateProgress({ estimate: null, requestedAt: null }, T0 + 999_999)).toBe('WAITING');
  });
});

describe('writing a distance for people', () => {
  it.each([
    [0, '0 m'],
    [4, '0 m'],
    [5, '10 m'],
    [849, '850 m'],
    [994, '990 m'],
    [995, '1 km'],
    [999.6, '1 km'],
    [1000, '1 km'],
    [1049, '1 km'],
    [1050, '1.1 km'],
    [8_234, '8.2 km'],
    [8_251, '8.3 km'],
    [99_949, '99.9 km'],
    [99_950, '100 km'],
    [180_400, '180 km'],
    [1_234_567, '1235 km'],
  ])('writes %s m as %s', (meters, text) => {
    expect(formatDistance(meters)).toBe(text);
  });
});

describe('writing a time for people', () => {
  it.each([
    [0, 'under 1 min'],
    [29, 'under 1 min'],
    [30, '1 min'],
    [89, '1 min'],
    [90, '2 min'],
    [1080, '18 min'],
    [3570, '1 h'],
    [3599, '1 h'],
    [3600, '1 h'],
    [3900, '1 h 5 min'],
    [7200, '2 h'],
    [8_100, '2 h 15 min'],
  ])('writes %s s as %s', (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });

  it('puts the time and the distance together', () => {
    expect(describeEstimate({ distanceMeters: 8234, durationSeconds: 1080 })).toBe(
      '18 min, 8.2 km',
    );
  });
});

describe('an arrival time that leaves too little for the trip', () => {
  const NOW = Date.UTC(2026, 8, 21, 10, 0, 0);
  const MIN = 60_000;

  it('is no shortfall without an arrival time', () => {
    expect(
      arrivalShortfallMinutes({
        departureAt: null,
        now: NOW,
        arriveBy: null,
        durationSeconds: 99_999,
      }),
    ).toBe(0);
  });

  it('counts from now when leaving now, and from the chosen time otherwise', () => {
    // 18 minutes of trip: leaving now arrives at 10:18.
    const base = { now: NOW, durationSeconds: 1080 };
    expect(arrivalShortfallMinutes({ ...base, departureAt: null, arriveBy: NOW + 18 * MIN })).toBe(
      0,
    );
    expect(arrivalShortfallMinutes({ ...base, departureAt: null, arriveBy: NOW + 30 * MIN })).toBe(
      0,
    );
    expect(arrivalShortfallMinutes({ ...base, departureAt: null, arriveBy: NOW + 10 * MIN })).toBe(
      8,
    );
    // Leaving at 12:00 arrives at 12:18, whatever "now" is.
    const noon = NOW + 120 * MIN;
    expect(arrivalShortfallMinutes({ ...base, departureAt: noon, arriveBy: noon + 17 * MIN })).toBe(
      1,
    );
    expect(arrivalShortfallMinutes({ ...base, departureAt: noon, arriveBy: noon + 18 * MIN })).toBe(
      0,
    );
  });

  it('rounds a part of a minute up, so a shortfall is never written as none', () => {
    const base = { now: NOW, departureAt: null, durationSeconds: 1080 };
    expect(arrivalShortfallMinutes({ ...base, arriveBy: NOW + 18 * MIN - 1 })).toBe(1);
    expect(arrivalShortfallMinutes({ ...base, arriveBy: NOW + 17 * MIN - 1 })).toBe(2);
  });
});
