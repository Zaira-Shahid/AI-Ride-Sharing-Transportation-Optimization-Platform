import { describe, expect, it } from 'vitest';
import { formatMinorUnits } from './money';

describe('formatMinorUnits', () => {
  it('formats a whole-dollar amount', () => {
    expect(formatMinorUnits(1200, 'usd')).toBe('$12.00');
  });

  it('formats an amount with cents', () => {
    expect(formatMinorUnits(1250, 'usd')).toBe('$12.50');
  });

  it("accepts a lower-case ISO currency code (fareConfig.ts's own convention)", () => {
    expect(formatMinorUnits(500, 'eur')).toBe('€5.00');
  });
});
