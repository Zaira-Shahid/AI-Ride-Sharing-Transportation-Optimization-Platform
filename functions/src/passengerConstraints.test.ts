import { describe, expect, it } from 'vitest';
import { checkProtectedConstraints, cumulativeSecondsToStop } from './passengerConstraints';

const GENEROUS = { allowSharedRide: true, allowRouteChange: true, arrivalDeadlineMs: null };

describe('checkProtectedConstraints', () => {
  it('is null when nothing is violated', () => {
    expect(
      checkProtectedConstraints(GENEROUS, {
        shared: true,
        routeChangedForThem: true,
        expectedDropoffAtMs: 1_000,
      }),
    ).toBeNull();
  });

  it('flags a shared plan for a passenger who opted out of sharing', () => {
    expect(
      checkProtectedConstraints(
        { ...GENEROUS, allowSharedRide: false },
        { shared: true, routeChangedForThem: false, expectedDropoffAtMs: 1_000 },
      ),
    ).toBe('SHARED_RIDE_NOT_ALLOWED');
  });

  it('does not flag a solo plan for a passenger who opted out of sharing', () => {
    expect(
      checkProtectedConstraints(
        { ...GENEROUS, allowSharedRide: false },
        { shared: false, routeChangedForThem: false, expectedDropoffAtMs: 1_000 },
      ),
    ).toBeNull();
  });

  it('flags a moved stop for a passenger who opted out of route changes', () => {
    expect(
      checkProtectedConstraints(
        { ...GENEROUS, allowRouteChange: false },
        { shared: false, routeChangedForThem: true, expectedDropoffAtMs: 1_000 },
      ),
    ).toBe('ROUTE_CHANGE_NOT_ALLOWED');
  });

  it('does not flag a first-time match (routeChangedForThem: false) for that same passenger', () => {
    expect(
      checkProtectedConstraints(
        { ...GENEROUS, allowRouteChange: false },
        { shared: false, routeChangedForThem: false, expectedDropoffAtMs: 1_000 },
      ),
    ).toBeNull();
  });

  it('flags an expected dropoff after the hard deadline', () => {
    expect(
      checkProtectedConstraints(
        { ...GENEROUS, arrivalDeadlineMs: 999 },
        { shared: false, routeChangedForThem: false, expectedDropoffAtMs: 1_000 },
      ),
    ).toBe('ARRIVE_BY_DEADLINE');
  });

  it('does not flag an expected dropoff exactly at, or before, the deadline', () => {
    expect(
      checkProtectedConstraints(
        { ...GENEROUS, arrivalDeadlineMs: 1_000 },
        { shared: false, routeChangedForThem: false, expectedDropoffAtMs: 1_000 },
      ),
    ).toBeNull();
  });

  it('checks shared-ride before route-change before the deadline, in that order', () => {
    expect(
      checkProtectedConstraints(
        { allowSharedRide: false, allowRouteChange: false, arrivalDeadlineMs: 0 },
        { shared: true, routeChangedForThem: true, expectedDropoffAtMs: 1_000 },
      ),
    ).toBe('SHARED_RIDE_NOT_ALLOWED');
  });
});

describe('cumulativeSecondsToStop', () => {
  const LEGS = [
    { distanceMeters: 1000, durationSeconds: 300 },
    { distanceMeters: 2000, durationSeconds: 600 },
    { distanceMeters: 1000, durationSeconds: 300 },
  ];

  it('sums every leg up to and including the given stop index', () => {
    expect(cumulativeSecondsToStop(LEGS, 0)).toBe(300);
    expect(cumulativeSecondsToStop(LEGS, 1)).toBe(900);
    expect(cumulativeSecondsToStop(LEGS, 2)).toBe(1200);
  });

  it('is 0 for an empty legs array', () => {
    expect(cumulativeSecondsToStop([], 0)).toBe(0);
  });
});
