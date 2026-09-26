import { describe, expect, it } from 'vitest';
import { savePushToken } from '../../functions/src/pushTokens';
import { admin } from './support';

// Module 10.2's own push-token prerequisite, tested directly against savePushToken (not through the
// callable in index.ts) - the same "call the function directly" approach paymentMethods.int.test.ts's
// own tests take.

const VALID_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

let counter = 0;
async function activePerson(role: 'PASSENGER' | 'DRIVER', prefix: string) {
  counter += 1;
  const uid = `${prefix}-${counter}`;
  await admin()
    .firestore.doc(`users/${uid}`)
    .set({
      role,
      name: 'Pat',
      email: `${uid}@example.test`,
      phone: null,
      photoUrl: null,
      status: 'ACTIVE',
      pushToken: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  return uid;
}

const caller = (uid: string, role: 'PASSENGER' | 'DRIVER') => ({
  uid,
  role,
  emailVerified: true,
});

describe('savePushToken (functions + firestore emulator)', () => {
  it("saves a passenger's own token", async () => {
    const uid = await activePerson('PASSENGER', 'push-passenger');

    const result = await savePushToken({ firestore: admin().firestore }, caller(uid, 'PASSENGER'), {
      token: VALID_TOKEN,
    });

    expect(result).toEqual({ status: 'saved' });
    expect((await admin().firestore.doc(`users/${uid}`).get()).data()?.pushToken).toBe(VALID_TOKEN);
  });

  it("saves a driver's own token", async () => {
    const uid = await activePerson('DRIVER', 'push-driver');

    await savePushToken({ firestore: admin().firestore }, caller(uid, 'DRIVER'), {
      token: VALID_TOKEN,
    });

    expect((await admin().firestore.doc(`users/${uid}`).get()).data()?.pushToken).toBe(VALID_TOKEN);
  });

  it('replaces a previously saved token', async () => {
    const uid = await activePerson('PASSENGER', 'push-replace');
    await admin().firestore.doc(`users/${uid}`).update({ pushToken: 'ExponentPushToken[old]' });

    await savePushToken({ firestore: admin().firestore }, caller(uid, 'PASSENGER'), {
      token: VALID_TOKEN,
    });

    expect((await admin().firestore.doc(`users/${uid}`).get()).data()?.pushToken).toBe(VALID_TOKEN);
  });

  it('refuses a token not shaped like a real Expo push token, storing nothing', async () => {
    const uid = await activePerson('PASSENGER', 'push-invalid');

    await expect(
      savePushToken({ firestore: admin().firestore }, caller(uid, 'PASSENGER'), {
        token: 'not-a-real-token',
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect((await admin().firestore.doc(`users/${uid}`).get()).data()?.pushToken).toBeNull();
  });

  it('refuses an unverified caller', async () => {
    const uid = await activePerson('PASSENGER', 'push-unverified');

    await expect(
      savePushToken(
        { firestore: admin().firestore },
        { uid, role: 'PASSENGER', emailVerified: false },
        { token: VALID_TOKEN },
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
