import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { computeDelayFlag, DELAY_THRESHOLD_MINUTES } from './trafficDelay';

const STOPS = [
  { kind: 'pickup', requestId: 'trip-a' },
  { kind: 'dropoff', requestId: 'trip-a' },
];

// origin -> pickup:a (5 min), pickup:a -> dropoff:a (10 min), dropoff:a -> destination (5 min).
const LEGS = [
  { distanceMeters: 1000, durationSeconds: 300 },
  { distanceMeters: 2000, durationSeconds: 600 },
  { distanceMeters: 1000, durationSeconds: 300 },
];

const CREATED_AT_MS = 1_000_000;
const createdAt = Timestamp.fromMillis(CREATED_AT_MS);

function statuses(status: string | undefined): Map<string, string | undefined> {
  return new Map([['trip-a', status]]);
}

describe('computeDelayFlag', () => {
  it("is not delayed while still within the current leg's own allotted time", () => {
    // Nothing done yet (stopIndex 0): allotted time for leg 0 is 300s. Only 200s have passed.
    const now = CREATED_AT_MS + 200_000;
    const flag = computeDelayFlag(
      { stops: STOPS, legs: LEGS, createdAt },
      statuses(undefined),
      now,
    );
    expect(flag).toBeNull();
  });

  it("is not delayed just under the threshold past the current leg's own allotted time", () => {
    const overrunMs = (DELAY_THRESHOLD_MINUTES * 60 - 1) * 1000;
    const now = CREATED_AT_MS + 300_000 + overrunMs;
    const flag = computeDelayFlag(
      { stops: STOPS, legs: LEGS, createdAt },
      statuses(undefined),
      now,
    );
    expect(flag).toBeNull();
  });

  it("flags a delay once the current leg's own allotted time is exceeded by the threshold", () => {
    const overrunMs = DELAY_THRESHOLD_MINUTES * 60 * 1000;
    const now = CREATED_AT_MS + 300_000 + overrunMs;
    const flag = computeDelayFlag(
      { stops: STOPS, legs: LEGS, createdAt },
      statuses(undefined),
      now,
    );
    expect(flag).toEqual({ extraMinutes: DELAY_THRESHOLD_MINUTES });
  });

  it("clears itself once a stop completes and unlocks a fresh leg's own budget", () => {
    // Same elapsed time as the flagged case above, but the pickup is now done: stopIndex 1, allotted
    // time becomes leg 0 + leg 1 = 900s, comfortably ahead of the 900s (300 + 5*60) elapsed.
    const overrunMs = DELAY_THRESHOLD_MINUTES * 60 * 1000;
    const now = CREATED_AT_MS + 300_000 + overrunMs;
    const flag = computeDelayFlag(
      { stops: STOPS, legs: LEGS, createdAt },
      statuses('PICKED_UP'),
      now,
    );
    expect(flag).toBeNull();
  });

  it('is null when the plan has no legs (written before module 8.6, or recovery failed)', () => {
    const flag = computeDelayFlag(
      { stops: STOPS, legs: null, createdAt },
      statuses(undefined),
      CREATED_AT_MS + 10_000_000,
    );
    expect(flag).toBeNull();
  });

  it('is null when legs and stops do not line up', () => {
    const flag = computeDelayFlag(
      { stops: STOPS, legs: [LEGS[0]!], createdAt },
      statuses(undefined),
      CREATED_AT_MS + 10_000_000,
    );
    expect(flag).toBeNull();
  });

  it('is null when createdAt is not a real Firestore Timestamp', () => {
    const flag = computeDelayFlag(
      { stops: STOPS, legs: LEGS, createdAt: new Date(CREATED_AT_MS) },
      statuses(undefined),
      CREATED_AT_MS + 10_000_000,
    );
    expect(flag).toBeNull();
  });

  it('uses the final leg to destination once every stop is done', () => {
    // Every stop COMPLETED: stopIndex is stops.length (2), allotted time is the full plan (1200s).
    const now = CREATED_AT_MS + 1200_000 + DELAY_THRESHOLD_MINUTES * 60 * 1000;
    const flag = computeDelayFlag(
      { stops: STOPS, legs: LEGS, createdAt },
      statuses('COMPLETED'),
      now,
    );
    expect(flag).toEqual({ extraMinutes: DELAY_THRESHOLD_MINUTES });
  });
});
