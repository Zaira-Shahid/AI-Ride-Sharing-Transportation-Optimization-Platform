import type { FareConfig } from './fareConfig.js';

// Module 9.2 (payment authorization): a first, deliberately simple fare estimate - base + per-km +
// per-minute, from the same numbers module 9.1's fareConfig already holds. The spec's own economic
// model (section 34) names exactly these terms (base trip cost + distance/time component); the
// shared-ride discount and platform fee it also names apply to the FINAL fare at trip completion
// (module 9.3, not built yet, which reuses this same function rather than a second copy of it).

export type FareRates = Pick<
  FareConfig,
  'baseFareMinorUnits' | 'perKmMinorUnits' | 'perMinuteMinorUnits'
>;

/** base + perKm*distance + perMinute*duration, in the config's own minor currency units. */
export function computeFareMinorUnits(
  rates: FareRates,
  distanceMeters: number,
  durationSeconds: number,
): number {
  const distanceKm = distanceMeters / 1000;
  const durationMinutes = durationSeconds / 60;
  return Math.round(
    rates.baseFareMinorUnits +
      rates.perKmMinorUnits * distanceKm +
      rates.perMinuteMinorUnits * durationMinutes,
  );
}

/**
 * How much extra a payment authorization (module 9.2) holds over the plain estimate, to cover the
 * final fare coming in higher after a delay or route change (Phase 8) without needing a second
 * authorization at capture time (module 9.4, not built yet). User-approved.
 */
export const AUTHORIZATION_BUFFER_PERCENT = 20;

/** computeFareMinorUnits, plus AUTHORIZATION_BUFFER_PERCENT - what a hold actually asks for. */
export function computeAuthorizationAmountMinorUnits(
  rates: FareRates,
  distanceMeters: number,
  durationSeconds: number,
): number {
  return Math.round(
    computeFareMinorUnits(rates, distanceMeters, durationSeconds) *
      (1 + AUTHORIZATION_BUFFER_PERCENT / 100),
  );
}
