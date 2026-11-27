import { Timestamp, type Firestore } from 'firebase-admin/firestore';

// The driver's window to decline a company match (module A3b, docs/a3b-driver-decline-design.md): the
// small pieces the matching code needs to start a window. The decline and confirm functions live in
// driverDecision.ts. Kept apart so the matching files do not depend on those, and mirrored in
// @ridemesh/tenancy (tests/tenancy-parity.test.ts fails if they diverge).

export const DECLINE_WINDOW_DEFAULT_MINUTES = 5;
export const DECLINE_WINDOW_MIN_MINUTES = 0;
export const DECLINE_WINDOW_MAX_MINUTES = 30;

/**
 * The company's decline window in minutes, from its `settings` object. A missing or invalid value (not
 * a whole number from 0 to 30) is the default, never an error. 0 means a match is final at once.
 */
export function declineWindowMinutes(settings: unknown): number {
  const value =
    typeof settings === 'object' && settings !== null
      ? (settings as { driverDeclineWindowMinutes?: unknown }).driverDeclineWindowMinutes
      : undefined;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= DECLINE_WINDOW_MIN_MINUTES &&
    value <= DECLINE_WINDOW_MAX_MINUTES
    ? value
    : DECLINE_WINDOW_DEFAULT_MINUTES;
}

/** The window in milliseconds for one company. Only ever called for a company, never for a consumer. */
export async function readDeclineWindowMs(
  firestore: Firestore,
  companyId: string,
): Promise<number> {
  const company = await firestore.doc(`companies/${companyId}`).get();
  return declineWindowMinutes(company.get('settings')) * 60_000;
}

/**
 * What a company ride is stamped with when it is matched. A window of 0 is final at once. Otherwise the
 * match stands unless the driver declines before the deadline: nothing has to happen for it to stand.
 */
export function driverDecisionFor(now: number, windowMs: number) {
  return windowMs > 0
    ? { status: 'OPEN' as const, deadline: Timestamp.fromMillis(now + windowMs) }
    : { status: 'CONFIRMED' as const, deadline: Timestamp.fromMillis(now) };
}
