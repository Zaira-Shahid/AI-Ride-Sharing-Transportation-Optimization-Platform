import { describe, expect, it } from 'vitest';
import {
  authorizeIdempotencyKey,
  createStripeProvider,
  stripeConfigFromEnvironment,
} from './stripeProvider';

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
    tripId: 'trip_1',
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

describe('createStripeProvider.verifyWebhookEvent', () => {
  const params = {
    payload: '{"id":"evt_123"}',
    signature: 't=1,v1=abc',
    webhookSecret: 'whsec_abc',
  };

  it('is verified when the signature checks out', () => {
    const fakeEvent = { id: 'evt_123', type: 'charge.dispute.created' };
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      webhooks: {
        constructEvent: (payload: string, signature: string, secret: string) => {
          expect(payload).toBe(params.payload);
          expect(signature).toBe(params.signature);
          expect(secret).toBe(params.webhookSecret);
          return fakeEvent;
        },
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(provider.verifyWebhookEvent(params)).toEqual({ status: 'verified', event: fakeEvent });
  });

  it('is invalid when the client throws (a missing or mismatched signature)', () => {
    const provider = createStripeProvider({ secretKey: 'sk_test_abc' }, {
      webhooks: {
        constructEvent: () => {
          throw new Error('No signatures found matching the expected signature for payload.');
        },
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    expect(provider.verifyWebhookEvent(params)).toEqual({ status: 'invalid' });
  });
});

describe('createStripeProvider.deleteCustomer', () => {
  const providerWith = (del: (id: string) => Promise<unknown>) =>
    createStripeProvider({ secretKey: 'sk_test_abc' }, {
      customers: { del },
    } as unknown as Parameters<typeof createStripeProvider>[1]);

  it('is deleted when Stripe confirms, passing the customer id through', async () => {
    const seen: string[] = [];
    const provider = providerWith(async (id) => {
      seen.push(id);
      return { deleted: true };
    });
    expect(await provider.deleteCustomer({ stripeCustomerId: 'cus_1' })).toEqual({
      status: 'deleted',
    });
    expect(seen).toEqual(['cus_1']);
  });

  it('counts a customer Stripe no longer has as deleted, so a retry succeeds', async () => {
    const provider = providerWith(async () => {
      throw Object.assign(new Error('No such customer'), { code: 'resource_missing' });
    });
    expect(await provider.deleteCustomer({ stripeCustomerId: 'cus_gone' })).toEqual({
      status: 'deleted',
    });
  });

  it('is failed for any other Stripe error', async () => {
    const provider = providerWith(async () => {
      throw new Error('Stripe is unreachable');
    });
    expect(await provider.deleteCustomer({ stripeCustomerId: 'cus_1' })).toEqual({
      status: 'failed',
    });
  });
});

describe('idempotency keys (Phase 14, payment compliance)', () => {
  const secret = { secretKey: 'sk_test_abc' };
  const authorize = {
    tripId: 'trip_1',
    stripeCustomerId: 'cus_123',
    paymentMethodId: 'pm_123',
    amountMinorUnits: 1_200,
    currency: 'usd',
  };

  it('sends the same authorization key for the same trip, card and amount, so a retry replays', async () => {
    const keys: unknown[] = [];
    const provider = createStripeProvider(secret, {
      paymentIntents: {
        create: async (_body: unknown, opts: { idempotencyKey: string }) => {
          keys.push(opts.idempotencyKey);
          return { id: 'pi_1', status: 'requires_capture' };
        },
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    await provider.authorizePayment(authorize);
    await provider.authorizePayment({ ...authorize });
    expect(keys).toEqual([authorizeIdempotencyKey(authorize), authorizeIdempotencyKey(authorize)]);
    expect(keys[0]).toBe('authorize-trip_1-pm_123-1200');
  });

  it('changes the authorization key when the card, the amount or the trip changes', () => {
    const base = authorizeIdempotencyKey(authorize);
    expect(authorizeIdempotencyKey({ ...authorize, paymentMethodId: 'pm_456' })).not.toBe(base);
    expect(authorizeIdempotencyKey({ ...authorize, amountMinorUnits: 1_300 })).not.toBe(base);
    expect(authorizeIdempotencyKey({ ...authorize, tripId: 'trip_2' })).not.toBe(base);
  });

  it('sends a key on capture, void and refund', async () => {
    const seen: Record<string, unknown> = {};
    const provider = createStripeProvider(secret, {
      paymentIntents: {
        capture: async (_id: string, _body: unknown, opts: { idempotencyKey: string }) => {
          seen.capture = opts.idempotencyKey;
          return { id: 'pi_1', status: 'succeeded' };
        },
        cancel: async (_id: string, _body: unknown, opts: { idempotencyKey: string }) => {
          seen.void = opts.idempotencyKey;
          return { id: 'pi_1', status: 'canceled' };
        },
      },
      refunds: {
        create: async (_body: unknown, opts: { idempotencyKey: string }) => {
          seen.refund = opts.idempotencyKey;
          return { id: 're_1', status: 'succeeded' };
        },
      },
    } as unknown as Parameters<typeof createStripeProvider>[1]);
    await provider.capturePayment({ paymentIntentId: 'pi_1', amountMinorUnits: 800 });
    await provider.voidPayment({ paymentIntentId: 'pi_1' });
    await provider.refundPayment({ paymentIntentId: 'pi_1', amountMinorUnits: 640 });
    expect(seen).toEqual({
      capture: 'capture-pi_1-800',
      void: 'void-pi_1',
      refund: 'refund-pi_1-640',
    });
  });
});
