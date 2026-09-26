import { describe, expect, it } from 'vitest';
import { sendPushToUser } from '../../functions/src/pushNotifications';
import type { PushProvider } from '../../functions/src/pushProvider';
import { admin } from './support';

// Module 10.1/10.2's own shared building block, tested directly against sendPushToUser with a fake
// PushProvider - the same "call the function directly" approach this whole session's payment modules
// already take. Nothing calls this yet (foundation-only scope for this pass, see the file's own note).

function fakePush(overrides: Partial<PushProvider> = {}): PushProvider {
  return {
    sendPush: async () => ({ status: 'sent' }),
    ...overrides,
  };
}

let counter = 0;
async function userWithToken(token: string | null): Promise<string> {
  counter += 1;
  const uid = `push-user-${counter}`;
  await admin().firestore.doc(`users/${uid}`).set({ pushToken: token });
  return uid;
}

describe('sendPushToUser (functions + firestore emulator, fake push provider)', () => {
  it("sends to the user's own saved token", async () => {
    const uid = await userWithToken('ExponentPushToken[abc]');
    let sentTo: string | null = null;
    const push = fakePush({
      sendPush: async (params) => {
        sentTo = params.token;
        return { status: 'sent' };
      },
    });

    await sendPushToUser({ firestore: admin().firestore, push }, uid, {
      title: 'Hello',
      body: 'World',
    });

    expect(sentTo).toBe('ExponentPushToken[abc]');
  });

  it('does nothing when the user has no saved token', async () => {
    const uid = await userWithToken(null);
    let calls = 0;
    const push = fakePush({
      sendPush: async () => {
        calls += 1;
        return { status: 'sent' };
      },
    });

    await sendPushToUser({ firestore: admin().firestore, push }, uid, {
      title: 'Hello',
      body: 'World',
    });

    expect(calls).toBe(0);
  });

  it('does nothing (and does not throw) when the user does not exist', async () => {
    await expect(
      sendPushToUser({ firestore: admin().firestore, push: fakePush() }, 'does-not-exist', {
        title: 'Hello',
        body: 'World',
      }),
    ).resolves.toBeUndefined();
  });

  it('never throws even when the push provider itself fails', async () => {
    const uid = await userWithToken('ExponentPushToken[abc]');
    const push = fakePush({
      sendPush: async () => {
        throw new Error('Network error.');
      },
    });

    await expect(
      sendPushToUser({ firestore: admin().firestore, push }, uid, {
        title: 'Hello',
        body: 'World',
      }),
    ).resolves.toBeUndefined();
  });
});
