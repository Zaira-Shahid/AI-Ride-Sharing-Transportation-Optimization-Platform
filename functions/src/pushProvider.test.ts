import { describe, expect, it } from 'vitest';
import { createPushProvider, pushConfigFromEnvironment } from './pushProvider';

const VALID_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

describe('pushConfigFromEnvironment', () => {
  it('has a null accessToken when EXPO_ACCESS_TOKEN is not set', () => {
    expect(pushConfigFromEnvironment({})).toEqual({ accessToken: null });
  });

  it('has a null accessToken when EXPO_ACCESS_TOKEN is blank', () => {
    expect(pushConfigFromEnvironment({ EXPO_ACCESS_TOKEN: '   ' })).toEqual({ accessToken: null });
  });

  it('reads and trims a configured access token', () => {
    expect(pushConfigFromEnvironment({ EXPO_ACCESS_TOKEN: ' abc123 ' })).toEqual({
      accessToken: 'abc123',
    });
  });
});

describe('createPushProvider.sendPush', () => {
  it('is sent when Expo confirms the ticket (ok)', async () => {
    const provider = createPushProvider({ accessToken: null }, {
      sendPushNotificationsAsync: async (messages: unknown[]) => {
        expect(messages).toEqual([{ to: VALID_TOKEN, title: 'Hello', body: 'World' }]);
        return [{ status: 'ok', id: 'ticket-1' }];
      },
    } as unknown as Parameters<typeof createPushProvider>[1]);
    expect(await provider.sendPush({ token: VALID_TOKEN, title: 'Hello', body: 'World' })).toEqual({
      status: 'sent',
    });
  });

  it('is failed when the token is not shaped like a real Expo push token', async () => {
    const provider = createPushProvider({ accessToken: null }, {
      sendPushNotificationsAsync: async () => [{ status: 'ok', id: 'ticket-1' }],
    } as unknown as Parameters<typeof createPushProvider>[1]);
    expect(
      await provider.sendPush({ token: 'not-a-real-token', title: 'Hello', body: 'World' }),
    ).toEqual({ status: 'failed' });
  });

  it('is failed when Expo returns an error ticket (e.g. an unregistered device)', async () => {
    const provider = createPushProvider({ accessToken: null }, {
      sendPushNotificationsAsync: async () => [{ status: 'error', message: 'DeviceNotRegistered' }],
    } as unknown as Parameters<typeof createPushProvider>[1]);
    expect(await provider.sendPush({ token: VALID_TOKEN, title: 'Hello', body: 'World' })).toEqual({
      status: 'failed',
    });
  });

  it('is failed when the client throws', async () => {
    const provider = createPushProvider({ accessToken: null }, {
      sendPushNotificationsAsync: async () => {
        throw new Error('Network error.');
      },
    } as unknown as Parameters<typeof createPushProvider>[1]);
    expect(await provider.sendPush({ token: VALID_TOKEN, title: 'Hello', body: 'World' })).toEqual({
      status: 'failed',
    });
  });
});
