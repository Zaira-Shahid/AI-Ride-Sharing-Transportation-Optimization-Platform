import { Expo } from 'expo-server-sdk';

// Module 10.1 (push notifications foundation): Expo's own push notification service, not raw native
// FCM (spec's literal wording) - user-approved: the whole app stays Expo-Go-testable (no push package
// or custom native config exists yet in apps/passenger or apps/driver), and Expo's service wraps
// FCM/APNs under the hood anyway, so nothing the spec actually cares about (delivering a push) is
// lost by choosing it. Unlike Stripe or the optimization service, Expo's push API needs no
// account/secret to use at all - EXPO_ACCESS_TOKEN is optional (an extra layer Expo added for
// higher-volume senders), so there is no "not configured yet" gate here the way every other
// external-service module in this codebase has needed one; sendPush can always be attempted, and
// simply has nothing to send to until a real device saves a token (Module 10.2) - the same "safe
// no-op for lack of data, not for lack of config" shape Module 9.2's own authorizeTripPayment has.

export interface PushConfig {
  accessToken: string | null;
}

/** EXPO_ACCESS_TOKEN from the environment; null (not required) when it is not set. */
export function pushConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): PushConfig {
  const accessToken = env.EXPO_ACCESS_TOKEN?.trim();
  return { accessToken: accessToken ? accessToken : null };
}

export interface SendPushParams {
  token: string;
  title: string;
  body: string;
}

export type SendPushOutcome = { status: 'sent' } | { status: 'failed' };

export interface PushProvider {
  /**
   * Sends one push notification. 'failed' covers an invalid token, a device that has unregistered, or
   * any other reason Expo's own service would not confirm it - never thrown, the same "an expected
   * outcome, not a system failure" stance the rest of this codebase's own provider interfaces take.
   */
  sendPush(params: SendPushParams): Promise<SendPushOutcome>;
}

type ExpoClient = Pick<Expo, 'sendPushNotificationsAsync'>;

/**
 * `expoClient` is normally omitted (a real Expo client is built from `config`); tests inject a
 * stand-in shaped like the one real call this makes, the same dependency-injection pattern
 * createStripeProvider's own `stripeClient` uses.
 */
export function createPushProvider(config: PushConfig, expoClient?: ExpoClient): PushProvider {
  const expo =
    expoClient ?? new Expo(config.accessToken ? { accessToken: config.accessToken } : {});
  return {
    async sendPush(params) {
      if (!Expo.isExpoPushToken(params.token)) return { status: 'failed' };
      try {
        const [ticket] = await expo.sendPushNotificationsAsync([
          { to: params.token, title: params.title, body: params.body },
        ]);
        if (ticket?.status !== 'ok') return { status: 'failed' };
        return { status: 'sent' };
      } catch {
        return { status: 'failed' };
      }
    },
  };
}
