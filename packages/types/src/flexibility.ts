import { z } from 'zod';
import { flexibilityLevelSchema, type FlexibilityLevel } from './states';

// How much a passenger will bend for a shared ride (spec section 3, "passenger consent"). The
// optimizer may only propose plans inside these limits, and must ask before it goes outside them.
// The limits are chosen as a level, which sets the numbers; the passenger cannot type their own.
// Module 3.7 puts them on the trip request (spec section 10, passengerPreferences) and must repeat
// isValidFlexibilityPreferences on the server (functions cannot import this package, so it will be
// mirrored and covered by the parity test).

// The levels themselves (STRICT, BALANCED, FLEXIBLE) are in ./states, with the other enumerations.

export interface LevelLimits {
  /** The furthest the passenger will walk to a pickup or from a drop-off, in metres. */
  maxWalkingDistance: number;
  /** The most extra time the passenger will accept on the trip, in minutes. */
  maxExtraTime: number;
  /** How far the passenger's own route may leave the direct route, in kilometres. */
  maxDetourDistance: number;
  /** Whether the route may be changed at all; the passenger can switch it either way. */
  allowRouteChange: boolean;
}

/**
 * What each level means (agreed for module 3.6). Strict: no meaningful route changes. Balanced:
 * reasonable walking and route changes. Flexible: significant shared routing.
 */
export const FLEXIBILITY_LEVEL_LIMITS: Record<FlexibilityLevel, LevelLimits> = {
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
};

/** What the passenger chooses: a level, and two switches that start from it. */
export interface Flexibility {
  level: FlexibilityLevel;
  /** Whether the passenger will share the ride with others. Starts on. */
  allowSharedRide: boolean;
  /** Whether the route may be changed. Starts from the level, and can be switched either way. */
  allowRouteChange: boolean;
}

/** What a passenger gets when they choose nothing: Balanced, sharing allowed. */
export const DEFAULT_FLEXIBILITY: Flexibility = {
  level: 'BALANCED',
  allowSharedRide: true,
  allowRouteChange: FLEXIBILITY_LEVEL_LIMITS.BALANCED.allowRouteChange,
};

/**
 * Chooses a level. The level sets whether the route may change (Strict off, the others on), which
 * the passenger can then switch; whether they will share is left as it was.
 */
export function withLevel(flexibility: Flexibility, level: FlexibilityLevel): Flexibility {
  return {
    level,
    allowSharedRide: flexibility.allowSharedRide,
    allowRouteChange: FLEXIBILITY_LEVEL_LIMITS[level].allowRouteChange,
  };
}

/** The passenger's preferences as a trip request carries them (spec section 10). */
export const flexibilityPreferencesSchema = z.object({
  flexibilityLevel: flexibilityLevelSchema,
  maxWalkingDistance: z.number().int().positive(),
  maxExtraTime: z.number().int().positive(),
  maxDetourDistance: z.number().int().positive(),
  allowSharedRide: z.boolean(),
  allowRouteChange: z.boolean(),
});
export type FlexibilityPreferences = z.infer<typeof flexibilityPreferencesSchema>;

/** The limits of the chosen level, with the two switches, in the form a trip request carries. */
export function flexibilityPreferences(flexibility: Flexibility): FlexibilityPreferences {
  const limits = FLEXIBILITY_LEVEL_LIMITS[flexibility.level];
  return {
    flexibilityLevel: flexibility.level,
    maxWalkingDistance: limits.maxWalkingDistance,
    maxExtraTime: limits.maxExtraTime,
    maxDetourDistance: limits.maxDetourDistance,
    allowSharedRide: flexibility.allowSharedRide,
    allowRouteChange: flexibility.allowRouteChange,
  };
}

/**
 * Whether preferences are ones a passenger could have chosen: a known level whose three numbers are
 * exactly that level's (they are not free to set), and the two switches as booleans. A request
 * carrying, say, Strict with a 5 km walk is refused rather than believed.
 */
export function isValidFlexibilityPreferences(value: unknown): value is FlexibilityPreferences {
  const parsed = flexibilityPreferencesSchema.safeParse(value);
  if (!parsed.success) return false;
  const limits = FLEXIBILITY_LEVEL_LIMITS[parsed.data.flexibilityLevel];
  return (
    parsed.data.maxWalkingDistance === limits.maxWalkingDistance &&
    parsed.data.maxExtraTime === limits.maxExtraTime &&
    parsed.data.maxDetourDistance === limits.maxDetourDistance
  );
}
