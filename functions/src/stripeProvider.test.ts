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

describe('createStripeProvider.createCustomer', () => {
  it("returns the client's own new customer id", async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      customers: { create: async () => ({ id: 'cus_123' }) },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.createCustomer({ email: 'pat@example.com', name: 'Pat' })).toBe(
      'cus_123',
    );
  });
});

describe('createStripeProvider.authorizePayment', () => {
  const params = {
    stripeCustomerId: 'cus_123',
    paymentMethodId: 'pm_123',
    amountMinorUnits: 1_200,
    currency: 'usd',
  };

  it('is authorized when Stripe confirms a hold (requires_capture)', async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      paymentIntents: {
        create: async () => ({ id: 'pi_123', status: 'requires_capture' }),
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.authorizePayment(params)).toEqual({
      status: 'authorized',
      paymentIntentId: 'pi_123',
    });
  });

  it('is declined when the client throws (a declined card, ...)', async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      paymentIntents: {
        create: async () => {
          throw new Error('Your card was declined.');
        },
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.authorizePayment(params)).toEqual({ status: 'declined' });
  });

  it('is declined when Stripe answers without ever reaching requires_capture', async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      paymentIntents: {
        create: async () => ({ id: 'pi_123', status: 'requires_action' }),
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.authorizePayment(params)).toEqual({ status: 'declined' });
  });
});

describe('createStripeProvider.capturePayment', () => {
  const params = { paymentIntentId: 'pi_123', amountMinorUnits: 800 };

  it('is captured when Stripe confirms the capture (succeeded)', async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      paymentIntents: {
        capture: async (id: string, opts: { amount_to_capture: number }) => {
          expect(id).toBe('pi_123');
          expect(opts.amount_to_capture).toBe(800);
          return { id, status: 'succeeded' };
        },
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.capturePayment(params)).toEqual({ status: 'captured' });
  });

  it('is failed when the client throws', async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      paymentIntents: {
        capture: async () => {
          throw new Error('The payment intent could not be captured.');
        },
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.capturePayment(params)).toEqual({ status: 'failed' });
  });

  it('is failed when Stripe answers without ever reaching succeeded', async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      paymentIntents: {
        capture: async () => ({ id: 'pi_123', status: 'canceled' }),
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.capturePayment(params)).toEqual({ status: 'failed' });
  });
});

describe('createStripeProvider.voidPayment', () => {
  const params = { paymentIntentId: 'pi_123' };

  it('is voided when Stripe confirms the cancellation (canceled)', async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      paymentIntents: {
        cancel: async (id: string) => {
          expect(id).toBe('pi_123');
          return { id, status: 'canceled' };
        },
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.voidPayment(params)).toEqual({ status: 'voided' });
  });

  it('is failed when the client throws', async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      paymentIntents: {
        cancel: async () => {
          throw new Error('The payment intent cannot be canceled.');
        },
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.voidPayment(params)).toEqual({ status: 'failed' });
  });

  it('is failed when Stripe answers without ever reaching canceled', async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      paymentIntents: {
        cancel: async () => ({ id: 'pi_123', status: 'requires_capture' }),
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.voidPayment(params)).toEqual({ status: 'failed' });
  });
});

describe('createStripeProvider.refundPayment', () => {
  const params = { paymentIntentId: 'pi_123', amountMinorUnits: 640 };

  it('is refunded when Stripe confirms it', async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      refunds: {
        create: async (opts: { payment_intent: string; amount: number }) => {
          expect(opts).toEqual({ payment_intent: 'pi_123', amount: 640 });
          return { id: 're_123', status: 'succeeded' };
        },
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.refundPayment(params)).toEqual({ status: 'refunded' });
  });

  it('is failed when the client throws', async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      refunds: {
        create: async () => {
          throw new Error('The charge has already been refunded.');
        },
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.refundPayment(params)).toEqual({ status: 'failed' });
  });

  it('is failed when Stripe reports the refund itself failed', async () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      refunds: {
        create: async () => ({ id: 're_123', status: 'failed' }),
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(await provider.refundPayment(params)).toEqual({ status: 'failed' });
  });
});
