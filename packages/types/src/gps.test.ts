import { describe, expect, it } from 'vitest';
import {
  LOCATION_THROTTLE,
  isUsableAccuracy,
  setJourneyOriginInputSchema,
  shouldSendLocation,
  updateDriverLocationInputSchema,
  type LocationSample,
} from './gps';

const T0 = Date.UTC(2026, 8, 21, 12, 0, 0);
const here = (overrides: Partial<LocationSample> = {}): LocationSample => ({
  latitude: 51.5,
  longitude: -0.1,
  at: T0,
  accuracy: 10,
  ...overrides,
});
// About 111 m north of `here` per 0.001 degrees of latitude.
const north = (metres: number) => 51.5 + metres / 111_195;

describe('the location throttle', () => {
  it('has the agreed numbers', () => {
    expect(LOCATION_THROTTLE).toEqual({
      minIntervalMs: 30_000,
      minDistanceMeters: 50,
      heartbeatIntervalMs: 300_000,
      maxAccuracyMeters: 100,
      serverMinIntervalMs: 15_000,
    });
    // The server's safety net is looser than the app's own rule, so a normal app is never refused.
    expect(LOCATION_THROTTLE.serverMinIntervalMs).toBeLessThan(LOCATION_THROTTLE.minIntervalMs);
  });

  it('sends the first usable reading', () => {
    expect(shouldSendLocation(null, here())).toBe(true);
    expect(shouldSendLocation(null, here({ accuracy: null }))).toBe(true);
  });

  it('never sends a reading that is too inaccurate, even the first', () => {
    expect(shouldSendLocation(null, here({ accuracy: 101 }))).toBe(false);
    expect(shouldSendLocation(null, here({ accuracy: Number.NaN }))).toBe(false);
    expect(shouldSendLocation(null, here({ accuracy: -1 }))).toBe(false);
    expect(shouldSendLocation(null, here({ accuracy: 100 }))).toBe(true);
    const last = here();
    expect(
      shouldSendLocation(last, here({ at: T0 + 60_000, latitude: north(500), accuracy: 500 })),
    ).toBe(false);
  });

  it('sends nothing sooner than 30 seconds, however far the driver has moved', () => {
    const last = here();
    expect(shouldSendLocation(last, here({ at: T0 + 29_999, latitude: north(5000) }))).toBe(false);
    expect(shouldSendLocation(last, here({ at: T0 + 30_000, latitude: north(5000) }))).toBe(true);
  });

  it('sends after 30 seconds only once the driver has moved 50 metres', () => {
    const last = here();
    expect(shouldSendLocation(last, here({ at: T0 + 60_000, latitude: north(40) }))).toBe(false);
    expect(shouldSendLocation(last, here({ at: T0 + 60_000, latitude: north(60) }))).toBe(true);
    // Sideways counts too: it is the distance between the two points.
    expect(shouldSendLocation(last, here({ at: T0 + 60_000, longitude: -0.1 + 0.001 }))).toBe(true);
  });

  it('sends a heartbeat every 5 minutes when the driver has not moved', () => {
    const last = here();
    expect(shouldSendLocation(last, here({ at: T0 + 299_999 }))).toBe(false);
    expect(shouldSendLocation(last, here({ at: T0 + 300_000 }))).toBe(true);
    expect(shouldSendLocation(last, here({ at: T0 + 300_000, accuracy: 500 }))).toBe(false);
  });

  it('follows a throttle it is given', () => {
    const last = here();
    const quick = { ...LOCATION_THROTTLE, minIntervalMs: 1_000, minDistanceMeters: 5 };
    expect(shouldSendLocation(last, here({ at: T0 + 2_000, latitude: north(10) }), quick)).toBe(
      true,
    );
    expect(shouldSendLocation(last, here({ at: T0 + 2_000, latitude: north(10) }))).toBe(false);
    const strict = { ...LOCATION_THROTTLE, maxAccuracyMeters: 20 };
    expect(shouldSendLocation(null, here({ accuracy: 50 }), strict)).toBe(false);
  });

  it('spaces a walk so that a minute of movement is a handful of writes, not hundreds', () => {
    // A reading every second for ten minutes, while moving at about 10 m/s (36 km/h).
    let last: LocationSample | null = null;
    let sent = 0;
    for (let second = 0; second < 600; second += 1) {
      const sample = here({ at: T0 + second * 1000, latitude: north(second * 10) });
      if (shouldSendLocation(last, sample)) {
        sent += 1;
        last = sample;
      }
    }
    expect(sent).toBe(20);
  });
});

describe('usable accuracy', () => {
  it.each([
    [0, true],
    [100, true],
    [100.5, false],
    [null, true],
    [undefined, true],
    [Number.POSITIVE_INFINITY, false],
  ])('treats %s as usable: %s', (accuracy, usable) => {
    expect(isUsableAccuracy(accuracy)).toBe(usable);
  });
});

describe('journey origin and location input', () => {
  it('accepts a real position and refuses the rest', () => {
    const ok = (origin: unknown) => setJourneyOriginInputSchema.safeParse({ origin }).success;
    expect(ok({ latitude: 51.5, longitude: -0.1 })).toBe(true);
    expect(ok({ latitude: 0, longitude: 1 })).toBe(true);
    expect(ok({ latitude: 0, longitude: 0 })).toBe(false);
    expect(ok({ latitude: 91, longitude: 0 })).toBe(false);
    expect(ok({ latitude: 0, longitude: 181 })).toBe(false);
    expect(ok({ latitude: '51', longitude: 0 })).toBe(false);
    expect(ok({ latitude: 51 })).toBe(false);
    expect(ok(null)).toBe(false);
    expect(setJourneyOriginInputSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a reading with or without an accuracy', () => {
    const ok = (input: unknown) => updateDriverLocationInputSchema.safeParse(input).success;
    expect(ok({ latitude: 51.5, longitude: -0.1, accuracy: 12 })).toBe(true);
    expect(ok({ latitude: 51.5, longitude: -0.1, accuracy: null })).toBe(true);
    expect(ok({ latitude: 51.5, longitude: -0.1 })).toBe(true);
    expect(ok({ latitude: 0, longitude: 0, accuracy: 5 })).toBe(false);
    expect(ok({ latitude: 51.5, longitude: -0.1, accuracy: -1 })).toBe(false);
    expect(ok({ latitude: 51.5, longitude: -0.1, accuracy: '5' })).toBe(false);
    expect(ok({ latitude: 95, longitude: -0.1 })).toBe(false);
  });
});
