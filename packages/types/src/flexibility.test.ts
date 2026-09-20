import { describe, expect, it } from 'vitest';
import { FLEXIBILITY_LEVELS } from './states';
import {
  DEFAULT_FLEXIBILITY,
  FLEXIBILITY_LEVEL_LIMITS,
  flexibilityPreferences,
  isValidFlexibilityPreferences,
  withLevel,
} from './flexibility';

describe('the levels', () => {
  it('are Strict, Balanced and Flexible, with the values agreed', () => {
    expect([...FLEXIBILITY_LEVELS]).toEqual(['STRICT', 'BALANCED', 'FLEXIBLE']);
    expect(FLEXIBILITY_LEVEL_LIMITS).toEqual({
      STRICT: {
        maxWalkingDistance: 200,
        maxExtraTime: 5,
        maxDetourDistance: 1,
        allowRouteChange: false,
      },
      BALANCED: {
        maxWalkingDistance: 500,
        maxExtraTime: 10,
        maxDetourDistance: 3,
        allowRouteChange: true,
      },
      FLEXIBLE: {
        maxWalkingDistance: 1000,
        maxExtraTime: 20,
        maxDetourDistance: 5,
        allowRouteChange: true,
      },
    });
  });

  it('never allow less in a more flexible level', () => {
    const [strict, balanced, flexible] = FLEXIBILITY_LEVELS.map(
      (level) => FLEXIBILITY_LEVEL_LIMITS[level],
    );
    for (const key of ['maxWalkingDistance', 'maxExtraTime', 'maxDetourDistance'] as const) {
      expect(strict?.[key]).toBeLessThan(balanced?.[key] ?? 0);
      expect(balanced?.[key]).toBeLessThan(flexible?.[key] ?? 0);
    }
  });

  it('have whole, positive limits', () => {
    for (const level of FLEXIBILITY_LEVELS) {
      const limits = FLEXIBILITY_LEVEL_LIMITS[level];
      for (const value of [
        limits.maxWalkingDistance,
        limits.maxExtraTime,
        limits.maxDetourDistance,
      ]) {
        expect(Number.isInteger(value) && value > 0).toBe(true);
      }
    }
  });
});

describe('the default', () => {
  it('is Balanced, sharing allowed, route changes allowed', () => {
    expect(DEFAULT_FLEXIBILITY).toEqual({
      level: 'BALANCED',
      allowSharedRide: true,
      allowRouteChange: true,
    });
  });
});

describe('withLevel', () => {
  it('sets the level and takes whether the route may change from it', () => {
    expect(withLevel(DEFAULT_FLEXIBILITY, 'STRICT')).toEqual({
      level: 'STRICT',
      allowSharedRide: true,
      allowRouteChange: false,
    });
    expect(withLevel(DEFAULT_FLEXIBILITY, 'FLEXIBLE')).toEqual({
      level: 'FLEXIBLE',
      allowSharedRide: true,
      allowRouteChange: true,
    });
  });

  it('keeps whether the passenger will share, and overrides an earlier route-change switch', () => {
    const noSharing = {
      level: 'BALANCED',
      allowSharedRide: false,
      allowRouteChange: false,
    } as const;
    expect(withLevel(noSharing, 'FLEXIBLE')).toEqual({
      level: 'FLEXIBLE',
      allowSharedRide: false,
      allowRouteChange: true,
    });
    const switchedOn = { level: 'STRICT', allowSharedRide: true, allowRouteChange: true } as const;
    expect(withLevel(switchedOn, 'STRICT').allowRouteChange).toBe(false);
  });
});

describe('flexibilityPreferences', () => {
  it('gives the limits of the level and the two switches, named as on a trip request', () => {
    expect(flexibilityPreferences(DEFAULT_FLEXIBILITY)).toEqual({
      flexibilityLevel: 'BALANCED',
      maxWalkingDistance: 500,
      maxExtraTime: 10,
      maxDetourDistance: 3,
      allowSharedRide: true,
      allowRouteChange: true,
    });
  });

  it('takes the switches as chosen, not from the level', () => {
    const chosen = { level: 'STRICT', allowSharedRide: false, allowRouteChange: true } as const;
    expect(flexibilityPreferences(chosen)).toMatchObject({
      flexibilityLevel: 'STRICT',
      maxWalkingDistance: 200,
      allowSharedRide: false,
      allowRouteChange: true,
    });
  });

  it('always gives something isValidFlexibilityPreferences accepts', () => {
    for (const level of FLEXIBILITY_LEVELS) {
      for (const allowSharedRide of [true, false]) {
        for (const allowRouteChange of [true, false]) {
          const preferences = flexibilityPreferences({ level, allowSharedRide, allowRouteChange });
          expect(isValidFlexibilityPreferences(preferences)).toBe(true);
        }
      }
    }
  });
});

describe('isValidFlexibilityPreferences', () => {
  const balanced = flexibilityPreferences(DEFAULT_FLEXIBILITY);

  it("refuses numbers that are not the level's, however reasonable they look", () => {
    expect(isValidFlexibilityPreferences({ ...balanced, maxWalkingDistance: 501 })).toBe(false);
    expect(isValidFlexibilityPreferences({ ...balanced, maxExtraTime: 11 })).toBe(false);
    expect(isValidFlexibilityPreferences({ ...balanced, maxDetourDistance: 4 })).toBe(false);
    // Strict's level with Flexible's walk.
    expect(
      isValidFlexibilityPreferences({
        ...flexibilityPreferences({ ...DEFAULT_FLEXIBILITY, level: 'STRICT' }),
        maxWalkingDistance: 1000,
      }),
    ).toBe(false);
  });

  it.each([
    ['an unknown level', { flexibilityLevel: 'EXTREME' }],
    ['no level', { flexibilityLevel: undefined }],
    ['a level in lower case', { flexibilityLevel: 'balanced' }],
    ['text for a number', { maxWalkingDistance: '500' }],
    ['a fraction', { maxExtraTime: 10.5 }],
    ['zero', { maxDetourDistance: 0 }],
    ['a negative number', { maxWalkingDistance: -500 }],
    ['sharing as text', { allowSharedRide: 'yes' }],
    ['no sharing setting', { allowSharedRide: undefined }],
    ['route change as a number', { allowRouteChange: 1 }],
  ])('refuses %s', (_label, change) => {
    expect(isValidFlexibilityPreferences({ ...balanced, ...change })).toBe(false);
  });

  it('refuses things that are not preferences at all', () => {
    for (const value of [null, undefined, 'BALANCED', 7, [], {}]) {
      expect(isValidFlexibilityPreferences(value)).toBe(false);
    }
  });

  it("accepts either switch on or off with a level's numbers", () => {
    expect(
      isValidFlexibilityPreferences({
        ...balanced,
        allowSharedRide: false,
        allowRouteChange: false,
      }),
    ).toBe(true);
  });
});
