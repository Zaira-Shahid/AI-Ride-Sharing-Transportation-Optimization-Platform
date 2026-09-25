// Module 8.8 (passenger constraint validation): the spec's own "Critical Rule: Passenger Consent"
// (section 3) - "the engine may propose changes, but it must not silently violate a passenger's
// agreed constraints" - names three protected ones no code anywhere yet checks: allowSharedRide,
// allowRouteChange and a hard arriveBy deadline. Every plan-writing path so far (Module 6.9's batch
// match, Module 8.4's insertion, Module 8.7's re-ordering) only ever checked the two NUMERIC detour
// limits (maxExtraTime/maxDetourDistance); the three fields below have been collected at request time
// (tripRequests.ts) and stored ever since, unread by any of them. This is the one shared checker,
// used by all three (user-approved: one shared checker, retrofit everywhere, rather than new code
// paths only) - the same pattern as checkChosenPlace/isValidFlexibilityPreferences elsewhere.
//
// A brand new assignment is never itself a "change" - allowRouteChange only ever gates a plan that
// moves a passenger who was ALREADY matched (Module 8.4/8.7); Module 6.9's own first-time matches
// never trip it, by construction (every call site below passes routeChangedForThem: false there).
// "Their own route changed" is measured the same simple way everywhere it is checked: whether their
// own pickup/dropoff stop INDEX moved between the old plan and the candidate one - a defensible,
// cheap proxy for "the shape of their own ride changed" without needing to store what they were
// originally quoted.

export type ProtectedConstraintViolation =
  'SHARED_RIDE_NOT_ALLOWED' | 'ROUTE_CHANGE_NOT_ALLOWED' | 'ARRIVE_BY_DEADLINE';

export interface ProtectedConstraintPreferences {
  allowSharedRide: boolean;
  allowRouteChange: boolean;
  /** Epoch ms; null when the passenger set no hard deadline. */
  arrivalDeadlineMs: number | null;
}

export interface ProtectedConstraintCandidate {
  /** Whether the plan being proposed would carry more than this one passenger. */
  shared: boolean;
  /** Whether this passenger's own stop position differs from an earlier plan (false for a first-time match - see the file-level note). */
  routeChangedForThem: boolean;
  /** This passenger's own expected dropoff time under the candidate plan, epoch ms. */
  expectedDropoffAtMs: number;
}

/**
 * Whichever protected constraint the candidate plan would violate for this one passenger, checked in
 * a fixed order (shared ride, then route change, then the deadline) so a caller logging or reporting
 * only the first reason is still deterministic; null when none is violated. Every call site above
 * decides for itself what "violated" then means for the plan as a whole - see each one's own note.
 */
export function checkProtectedConstraints(
  preferences: ProtectedConstraintPreferences,
  candidate: ProtectedConstraintCandidate,
): ProtectedConstraintViolation | null {
  if (!preferences.allowSharedRide && candidate.shared) return 'SHARED_RIDE_NOT_ALLOWED';
  if (!preferences.allowRouteChange && candidate.routeChangedForThem) {
    return 'ROUTE_CHANGE_NOT_ALLOWED';
  }
  if (
    preferences.arrivalDeadlineMs !== null &&
    candidate.expectedDropoffAtMs > preferences.arrivalDeadlineMs
  ) {
    return 'ARRIVE_BY_DEADLINE';
  }
  return null;
}

/**
 * The cumulative duration (seconds), from a plan's own start, to reach the stop at `stopIndex` in a
 * `[origin, ...stops, destination]`-aligned `legs` array (the same shape Module 8.6's own
 * computeDelayFlag and Module 8.7's legsForPlanPath already use) - legs[0..stopIndex] inclusive, since
 * leg i runs from point i to point i + 1 and stopIndex is 0-based within `stops` (so point
 * stopIndex + 1 overall).
 */
export function cumulativeSecondsToStop(
  legs: readonly { durationSeconds: number }[],
  stopIndex: number,
): number {
  let total = 0;
  for (let i = 0; i <= stopIndex; i += 1) {
    total += legs[i]?.durationSeconds ?? 0;
  }
  return total;
}
