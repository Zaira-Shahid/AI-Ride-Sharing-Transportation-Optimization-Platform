import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_BUFFER_PERCENT,
  computeAuthorizationAmountMinorUnits,
  computeDriverEarningsMinorUnits,
  computeFareMinorUnits,
  computeFinalFareMinorUnits,
  computePlatformFeeMinorUnits,
} from './fare';

const RATES = { baseFareMinorUnits: 250, perKmMinorUnits: 120, perMinuteMinorUnits: 15 };
const SHARED_RATES = { ...RATES, sharedRideDiscountPercent: 20 };

describe('computeFareMinorUnits', () => {
  it('sums base + per-km + per-minute', () => {
    // 250 + 120*5 + 15*10 = 250 + 600 + 150 = 1000
    expect(computeFareMinorUnits(RATES, 5_000, 600)).toBe(1_000);
  });

  it('is just the base fare for a zero-distance, zero-duration trip', () => {
    expect(computeFareMinorUnits(RATES, 0, 0)).toBe(250);
  });

  it('rounds to the nearest minor unit', () => {
    // 250 + 120*0.001 + 15*(1/60) = 250 + 0.12 + 0.25 = 250.37 -> 250
    expect(computeFareMinorUnits(RATES, 1, 1)).toBe(250);
  });
});

describe('computeAuthorizationAmountMinorUnits', () => {
  it('adds the buffer percentage on top of the plain fare', () => {
    const fare = computeFareMinorUnits(RATES, 5_000, 600);
    const authorized = computeAuthorizationAmountMinorUnits(RATES, 5_000, 600);
    expect(authorized).toBe(Math.round(fare * (1 + AUTHORIZATION_BUFFER_PERCENT / 100)));
    expect(authorized).toBe(1_200);
  });
});

describe('computeFinalFareMinorUnits', () => {
  it('is just the plain fare when the ride was not shared', () => {
    expect(computeFinalFareMinorUnits(SHARED_RATES, 5_000, 600, false)).toBe(1_000);
  });

  it('discounts the whole fare by sharedRideDiscountPercent when the ride was shared', () => {
    // 1000 * (1 - 20/100) = 800
    expect(computeFinalFareMinorUnits(SHARED_RATES, 5_000, 600, true)).toBe(800);
  });
});

describe('computePlatformFeeMinorUnits', () => {
  it('takes platformFeePercent of the final fare', () => {
    expect(computePlatformFeeMinorUnits({ platformFeePercent: 20 }, 800)).toBe(160);
  });

  it('rounds to the nearest minor unit', () => {
    expect(computePlatformFeeMinorUnits({ platformFeePercent: 15 }, 999)).toBe(150);
  });
});

describe('computeDriverEarningsMinorUnits', () => {
  it('is the final fare minus the platform fee', () => {
    expect(computeDriverEarningsMinorUnits(800, 160)).toBe(640);
  });

  it('is the whole final fare when the platform fee is zero', () => {
    expect(computeDriverEarningsMinorUnits(1_000, 0)).toBe(1_000);
  });
});
