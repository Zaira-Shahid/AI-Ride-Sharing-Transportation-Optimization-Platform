// Module 10.4 (payment captured push): the first place this codebase turns a minor-units amount (the
// form every fare/payment field is stored in, matching Stripe's own convention) into something a
// person actually reads, rather than another minor-units number carried through internal computation.

/** e.g. formatMinorUnits(1250, 'usd') -> '$12.50'. `currency` is a lower-case ISO 4217 code (fareConfig.ts's own convention) - Intl.NumberFormat itself is case-insensitive about it. */
export function formatMinorUnits(amountMinorUnits: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    amountMinorUnits / 100,
  );
}
