import type { Firestore } from 'firebase-admin/firestore';

// Module 9.1 (Stripe integration, scope also covers this by agreement): the spec's own commercial
// model section (34) refuses a hard-coded commission - "the exact commercial model must be
// configurable... do not build business logic around a hard-coded commission percentage". One
// Firestore document holds every rate a fare/payout calculation (modules 9.3/9.5/9.6, not built yet)
// will need, with launch-reasonable defaults; editing it is a future admin dashboard's job (Phase 11,
// not built yet) or, until then, a direct Firestore console edit by staff - no client write path
// exists yet, since nothing needs one.
//
// Amounts are minor currency units (e.g. cents for USD) throughout, matching how Stripe itself always
// expresses an amount - so a later module handing one straight to a Stripe call never needs to convert.

export const FARE_CONFIG_PATH = 'config/fare';

export interface FareConfig {
  /** A lower-case ISO 4217 currency code (Stripe's own expected form, e.g. 'usd'). */
  currency: string;
  baseFareMinorUnits: number;
  perKmMinorUnits: number;
  perMinuteMinorUnits: number;
  /** Applied to the shared-trip adjustment the spec's own economic model (section 34) describes. */
  sharedRideDiscountPercent: number;
  /** The platform's own cut of the fare; the rest is the driver's payout. */
  platformFeePercent: number;
}

/**
 * Placeholder numbers only - a real market/currency decision belongs to whoever configures this
 * document for launch, not to this module. $2.50 base + $1.20/km + $0.15/min, a 20% discount on the
 * shared portion of a trip, and a 20% platform fee are all deliberately round, easy-to-reason-about
 * starting values.
 */
export const DEFAULT_FARE_CONFIG: FareConfig = {
  currency: 'usd',
  baseFareMinorUnits: 250,
  perKmMinorUnits: 120,
  perMinuteMinorUnits: 15,
  sharedRideDiscountPercent: 20,
  platformFeePercent: 20,
};

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Reads config/fare, filling in DEFAULT_FARE_CONFIG for any field that is missing or the wrong type -
 * field by field, not the whole document at once, so a partial or malformed manual edit degrades one
 * rate at a time instead of silently falling back to every default. Never throws: a config document
 * that does not exist yet, or was mistyped, is not itself a system failure.
 */
export async function readFareConfig(firestore: Firestore): Promise<FareConfig> {
  const data = (await firestore.doc(FARE_CONFIG_PATH).get()).data() ?? {};
  return {
    currency:
      typeof data.currency === 'string' && data.currency
        ? data.currency
        : DEFAULT_FARE_CONFIG.currency,
    baseFareMinorUnits: isNumber(data.baseFareMinorUnits)
      ? data.baseFareMinorUnits
      : DEFAULT_FARE_CONFIG.baseFareMinorUnits,
    perKmMinorUnits: isNumber(data.perKmMinorUnits)
      ? data.perKmMinorUnits
      : DEFAULT_FARE_CONFIG.perKmMinorUnits,
    perMinuteMinorUnits: isNumber(data.perMinuteMinorUnits)
      ? data.perMinuteMinorUnits
      : DEFAULT_FARE_CONFIG.perMinuteMinorUnits,
    sharedRideDiscountPercent: isNumber(data.sharedRideDiscountPercent)
      ? data.sharedRideDiscountPercent
      : DEFAULT_FARE_CONFIG.sharedRideDiscountPercent,
    platformFeePercent: isNumber(data.platformFeePercent)
      ? data.platformFeePercent
      : DEFAULT_FARE_CONFIG.platformFeePercent,
  };
}
