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
//
// Module 9.2 (payment authorization) adds the next two narrow methods: createCustomer (paymentMethods.ts,
// once per passenger) and authorizePayment (paymentAuthorization.ts, a hold - capture_method: manual -
// never a charge). Both, like ping(), are never wired into a live trigger yet either (user-approved:
// build and test the logic now, wire it into the real match pipeline once a real card-entry UI exists -
// wiring it live today would mean every match fails authorization immediately, since nothing can save a
// payment method yet).

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
export interface CreateCustomerParams {
  email: string;
  name: string;
}

export interface AuthorizePaymentParams {
  stripeCustomerId: string;
  paymentMethodId: string;
  amountMinorUnits: number;
  currency: string;
}

export type AuthorizePaymentOutcome =
  { status: 'authorized'; paymentIntentId: string } | { status: 'declined' };

export interface CapturePaymentParams {
  paymentIntentId: string;
  /** Module 9.4: always the final fare (fare.ts), never the full held amount - the hold included
   * AUTHORIZATION_BUFFER_PERCENT precisely so a lower amount could be captured without a second
   * authorization. */
  amountMinorUnits: number;
}

export type CapturePaymentOutcome = { status: 'captured' } | { status: 'failed' };

export interface StripeProvider {
  ping(): Promise<boolean>;
  /** Creates a new Stripe Customer and returns its id. */
  createCustomer(params: CreateCustomerParams): Promise<string>;
  /**
   * Holds `amountMinorUnits` against the customer's saved payment method (capture_method: 'manual' -
   * this only ever holds, module 9.4's own capture step is what actually takes the money). 'declined'
   * covers every reason Stripe would not confirm it (a declined card, an expired one, the payment
   * method no longer attached, ...) - never thrown, the same "an expected outcome, not a system
   * failure" stance checkCandidateRoute's own 'unavailable' takes.
   */
  authorizePayment(params: AuthorizePaymentParams): Promise<AuthorizePaymentOutcome>;
  /**
   * Module 9.4 (payment capture): actually takes `amountMinorUnits` from the hold `authorizePayment`
   * placed. 'failed' covers every reason Stripe would not confirm it - never thrown, same stance as
   * authorizePayment's own 'declined'.
   */
  capturePayment(params: CapturePaymentParams): Promise<CapturePaymentOutcome>;
}

type StripeClient = Pick<Stripe, 'balance' | 'customers' | 'paymentIntents'>;

/**
 * `stripeClient` is normally omitted (a real Stripe client is built from `config`); tests inject a
 * stand-in shaped like the real calls this makes, the same dependency-injection pattern
 * createOsrmProvider's own `fetchImpl` uses.
 */
export function createStripeProvider(
  config: StripeConfig,
  stripeClient?: StripeClient,
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

    async createCustomer(params) {
      const customer = await client.customers.create({ email: params.email, name: params.name });
      return customer.id;
    },

    async authorizePayment(params) {
      try {
        const intent = await client.paymentIntents.create({
          amount: params.amountMinorUnits,
          currency: params.currency,
          customer: params.stripeCustomerId,
          payment_method: params.paymentMethodId,
          capture_method: 'manual',
          confirm: true,
          off_session: true,
        });
        if (intent.status !== 'requires_capture') return { status: 'declined' };
        return { status: 'authorized', paymentIntentId: intent.id };
      } catch {
        return { status: 'declined' };
      }
    },

    async capturePayment(params) {
      try {
        const intent = await client.paymentIntents.capture(params.paymentIntentId, {
          amount_to_capture: params.amountMinorUnits,
        });
        if (intent.status !== 'succeeded') return { status: 'failed' };
        return { status: 'captured' };
      } catch {
        return { status: 'failed' };
      }
    },
  };
}
