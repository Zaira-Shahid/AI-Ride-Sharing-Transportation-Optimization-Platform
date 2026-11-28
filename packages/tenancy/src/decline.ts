import { z } from 'zod';

// The driver's window to decline a company match (module A3b, docs/a3b-driver-decline-design.md).
// Mirrored in functions/src/driverDecision.ts; tests/tenancy-parity.test.ts fails if they diverge.

export const DECLINE_WINDOW_DEFAULT_MINUTES = 5;
export const DECLINE_WINDOW_MIN_MINUTES = 0;
export const DECLINE_WINDOW_MAX_MINUTES = 30;

/**
 * The company's decline window in minutes, from its `settings` object. A missing or invalid value
 * (not a whole number from 0 to 30) is the default, never an error: a company that has not chosen yet,
 * or whose setting is wrong, still gets a sensible window. 0 means a match is final at once.
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

const tripIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,128}$/);

export const declineMatchedRiderInputSchema = z.object({ tripId: tripIdSchema });
export type DeclineMatchedRiderInput = z.infer<typeof declineMatchedRiderInputSchema>;

export const confirmMatchedRiderInputSchema = z.object({ tripId: tripIdSchema });
export type ConfirmMatchedRiderInput = z.infer<typeof confirmMatchedRiderInputSchema>;

/** Written on a company ride when it is matched; a consumer ride never has it. */
export interface DriverDecision {
  /** OPEN while the driver may still decline; CONFIRMED once they accept, start the pickup, or the window is 0. */
  status: 'OPEN' | 'CONFIRMED';
  /** After this instant a decline is refused and the match stands. */
  deadline: number;
}

export interface DeclineMatchedRiderResult {
  status: 'declined' | 'unchanged';
}

export interface ConfirmMatchedRiderResult {
  status: 'confirmed' | 'unchanged';
}
