import { describe, expect, it } from 'vitest';
import { createStripeProvider, stripeConfigFromEnvironment } from './stripeProvider';

describe('stripeConfigFromEnvironment', () => {
  it('is null when STRIPE_SECRET_KEY is not set', () => {
    expect(stripeConfigFromEnvironment({})).toBeNull();
  });

  it('is null when STRIPE_SECRET_KEY is blank', () => {
    expect(stripeConfigFromEnvironment({ STRIPE_SECRET_KEY: '   ' })).toBeNull();
  });

  it('reads and trims a configured key', () => {
    expect(stripeConfigFromEnvironment({ STRIPE_SECRET_KEY: ' sk_test_abc ' })).toEqual({
      secretKey: 'sk_test_abc',
    });
  });
});

describe('createStripeProvider', () => {
  it('pings true when the client answers', async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      balance: { retrieve: async () => ({}) },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.ping()).toBe(true);
  });

  it('pings false when the client throws (a bad key, or Stripe unreachable)', async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_bad' }, {
      balance: {
        retrieve: async () => {
          throw new Error('Invalid API key.');
        },
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.ping()).toBe(false);
  });
});
