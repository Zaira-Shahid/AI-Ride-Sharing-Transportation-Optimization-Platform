import Stripe from 'stripe';

// Module 9.1 (Stripe integration): the foundation only - SDK wiring, configuration, and a lightweight
// connectivity check - the same "app + health check first" pattern Module 6.0 used for the
// optimization service, before any module builds real payment logic on top of it (9.2 onwards).
//
// User-approved: scaffolding only for now, no real Stripe account/test keys yet - the same "ship the
// abstraction, wire the real key in later" pattern Module 2.6's own Google Maps key followed.
// STRIPE_SECRET_KEY is read from the environment and is null until it exists; every future call site
// must treat a null config the same way calculateRoute treats a routing server that is not configured
// yet (Module 6.10's own OPTIMIZATION_SERVICE_URL check is the closest precedent). Nothing in this
// file is wired into index.ts yet - there is no payment operation to trigger it, by design.

export interface StripeConfig {
  secretKey: string;
}

/** STRIPE_SECRET_KEY from the environment; null when it is not set (Spark-plan/local environments, or simply not yet obtained). */
export function stripeConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  return secretKey ? { secretKey } : null;
}

/**
 * The one capability this foundation module needs: proof that the configured key can actually reach
 * Stripe. Later modules (9.2 onwards) add the real operations (payment intents, refunds, ...) as their
 * own narrow methods here, the same way RoutingProvider only ever grew one method per module that
 * needed one - never the whole SDK surface passed through.
 */
export interface StripeProvider {
  ping(): Promise<boolean>;
}

/**
 * `stripeClient` is normally omitted (a real Stripe client is built from `config`); tests inject a
 * stand-in shaped like the one real call this makes, the same dependency-injection pattern
 * createOsrmProvider's own `fetchImpl` uses.
 */
export function createStripeProvider(
  config: StripeConfig,
  stripeClient?: Pick<Stripe, 'balance'>,
): StripeProvider {
  const client = stripeClient ?? new Stripe(config.secretKey);
  return {
    async ping() {
      try {
        // A read-only call that works on any account, even one with no charges yet - a real "can this
        // key reach Stripe" check, not a guess.
        await client.balance.retrieve();
        return true;
      } catch {
        return false;
      }
    },
  };
}
