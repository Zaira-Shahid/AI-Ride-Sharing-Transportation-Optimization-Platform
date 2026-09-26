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

export type SharedRideFareRates = Pick<FareConfig, keyof FareRates | 'sharedRideDiscountPercent'>;

/**
 * Module 9.3 (fare calculation): the fare the passenger actually owes at trip completion -
 * computeFareMinorUnits, with sharedRideDiscountPercent taken off the WHOLE fare when `sharedRide`
 * is true. User-approved: a journey either had another matched passenger during this passenger's own
 * ride or it did not - there is no per-leg shared/solo breakdown tracked (see optimizationRun.ts and
 * planInsertion.ts, the two places `sharedRide` itself is set), so the discount cannot be scoped to
 * just the shared portion the way the spec's own economic model (section 34) describes it; a coarser
 * whole-fare discount is what the data actually supports.
 */
export function computeFinalFareMinorUnits(
  rates: SharedRideFareRates,
  distanceMeters: number,
  durationSeconds: number,
  sharedRide: boolean,
): number {
  const fare = computeFareMinorUnits(rates, distanceMeters, durationSeconds);
  return sharedRide ? Math.round(fare * (1 - rates.sharedRideDiscountPercent / 100)) : fare;
}

/**
 * The platform's own cut of `finalFareMinorUnits` (the rest is the driver's payout - module 9.5).
 * Informational only for now: no Stripe Connect account exists to actually pay a driver out (module
 * 9.1's own deferred decision), so this is stored on the trip for a later module to use, not
 * transferred anywhere by this one.
 */
export function computePlatformFeeMinorUnits(
  rates: Pick<FareConfig, 'platformFeePercent'>,
  finalFareMinorUnits: number,
): number {
  return Math.round(finalFareMinorUnits * (rates.platformFeePercent / 100));
}

/**
 * Module 9.5 (driver earnings): what the driver is owed for a trip - the final fare minus the
 * platform's own cut of it. A bookkeeping figure only: no Stripe Connect account exists to actually
 * pay a driver out (module 9.1's own deferred decision), so this only ever becomes a driverEarnings
 * ledger entry (driverEarnings.ts), never a real transfer.
 */
export function computeDriverEarningsMinorUnits(
  finalFareMinorUnits: number,
  platformFeeMinorUnits: number,
): number {
  return finalFareMinorUnits - platformFeeMinorUnits;
}

/**
 * Module 9.8 (receipts): the passenger-facing fare breakdown - deliberately does NOT include
 * platformFeeMinorUnits (an internal split, not something ride-sharing receipts typically show the
 * passenger). distanceTimeComponentMinorUnits and sharedRideDiscountMinorUnits are both derived as
 * differences of already-computed totals (never recomputed independently), so the four fields always
 * reconcile exactly: baseFareMinorUnits + distanceTimeComponentMinorUnits - sharedRideDiscountMinorUnits
 * === totalMinorUnits.
 */
export interface FareBreakdown {
  baseFareMinorUnits: number;
  distanceTimeComponentMinorUnits: number;
  /** 0 when the ride was not shared. */
  sharedRideDiscountMinorUnits: number;
  /** What the passenger actually paid - the same figure as finalFareMinorUnits (fare.ts). */
  totalMinorUnits: number;
}

export function computeFareBreakdown(
  rates: SharedRideFareRates,
  distanceMeters: number,
  durationSeconds: number,
  sharedRide: boolean,
): FareBreakdown {
  const plainFare = computeFareMinorUnits(rates, distanceMeters, durationSeconds);
  const totalMinorUnits = computeFinalFareMinorUnits(
    rates,
    distanceMeters,
    durationSeconds,
    sharedRide,
  );
  return {
    baseFareMinorUnits: rates.baseFareMinorUnits,
    distanceTimeComponentMinorUnits: plainFare - rates.baseFareMinorUnits,
    sharedRideDiscountMinorUnits: plainFare - totalMinorUnits,
    totalMinorUnits,
  };
}
