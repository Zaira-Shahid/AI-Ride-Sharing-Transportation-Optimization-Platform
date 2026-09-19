import { createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import {
  describeAuthError,
  registerAccount,
  saveProfile,
  subscribeToProfile,
  type ProfileSnapshot,
} from '../../packages/firebase/src';
import { PASSWORD, admin, createClient, signUp, uniqueEmail, verifyEmail } from './support';

async function verifiedPerson(role: 'PASSENGER' | 'DRIVER', prefix: string) {
  const client = createClient();
  const email = uniqueEmail(prefix);
  await registerAccount(client, {
    role,
    values: {
      name: 'Ada Lovelace',
      email,
      phone: '',
      password: PASSWORD,
      confirmPassword: PASSWORD,
    },
  });
  const user = client.auth.currentUser!;
  await verifyEmail(user, email);
  return { client, uid: user.uid, email };
}

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return describeAuthError(error);
  }
  throw new Error('Expected the promise to reject.');
}

const stored = async (uid: string) => (await admin().firestore.doc(`users/${uid}`).get()).data();

describe('saveProfile (real emulators, real sign-in tokens)', () => {
  it('saves name and phone to the profile, stamps updatedAt and updates the Auth display name', async () => {
    const { client, uid } = await verifiedPerson('PASSENGER', 'profile-save');
    const before = await stored(uid);

    await saveProfile(client, { name: '  Grace Hopper ', phone: ' +44 7700 900123 ' });

    const after = await stored(uid);
    expect(after).toMatchObject({
      name: 'Grace Hopper',
      phone: '+44 7700 900123',
      role: 'PASSENGER',
      status: 'ACTIVE',
      email: before?.email,
    });
    expect(after?.updatedAt.toMillis()).toBeGreaterThan(before?.updatedAt.toMillis());
    expect(after?.createdAt.toMillis()).toBe(before?.createdAt.toMillis());
    expect(client.auth.currentUser?.displayName).toBe('Grace Hopper');
  });

  it('works the same for a driver and lets the phone be cleared', async () => {
    const { client, uid } = await verifiedPerson('DRIVER', 'profile-driver');

    await saveProfile(client, { name: 'Dan Driver', phone: '+44 7700 900123' });
    expect((await stored(uid))?.phone).toBe('+44 7700 900123');

    await saveProfile(client, { name: 'Dan Driver', phone: '' });
    expect((await stored(uid))?.phone).toBeNull();
  });

  it('rejects invalid details before contacting the server', async () => {
    const { client, uid } = await verifiedPerson('PASSENGER', 'profile-invalid');
    const before = await stored(uid);

    expect((await failureOf(saveProfile(client, { name: '   ', phone: '' }))).kind).toBe(
      'validation',
    );
    expect((await failureOf(saveProfile(client, { name: 'Ada', phone: 'abc' }))).kind).toBe(
      'validation',
    );
    expect(await stored(uid)).toEqual(before);
  });

  it('is refused for an account whose email is not verified', async () => {
    const client = createClient();
    const email = uniqueEmail('profile-unverified');
    await registerAccount(client, {
      role: 'PASSENGER',
      values: { name: 'Ada', email, phone: '', password: PASSWORD, confirmPassword: PASSWORD },
    });
    const uid = client.auth.currentUser!.uid;

    const failure = await failureOf(saveProfile(client, { name: 'Changed', phone: '' }));

    expect(failure.kind).toBe('permission');
    expect((await stored(uid))?.name).toBe('Ada');
  });

  it('is refused for a suspended account', async () => {
    const { client, uid } = await verifiedPerson('PASSENGER', 'profile-suspended');
    await admin().firestore.doc(`users/${uid}`).update({ status: 'SUSPENDED' });

    const failure = await failureOf(saveProfile(client, { name: 'Changed', phone: '' }));

    expect(failure.kind).toBe('permission');
    expect((await stored(uid))?.name).toBe('Ada Lovelace');
  });

  it('cannot be used to change the role or another person, even with a real token', async () => {
    const { client, uid } = await verifiedPerson('PASSENGER', 'profile-attack');
    const other = await verifiedPerson('DRIVER', 'profile-victim');

    await expect(
      updateDoc(doc(client.db, `users/${uid}`), { role: 'ADMIN', updatedAt: serverTimestamp() }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      updateDoc(doc(client.db, `users/${other.uid}`), {
        name: 'Hijacked',
        updatedAt: serverTimestamp(),
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      setDoc(doc(client.db, `users/${uid}`), { role: 'ADMIN', name: 'Ada' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    expect((await stored(uid))?.role).toBe('PASSENGER');
    expect((await stored(other.uid))?.name).toBe('Ada Lovelace');
  });

  it('gives up with a connection message when the write does not complete in time', async () => {
    const { client } = await verifiedPerson('PASSENGER', 'profile-timeout');

    const failure = await failureOf(
      saveProfile(client, { name: 'Slow Save', phone: '' }, { timeoutMs: 1 }),
    );

    expect(failure).toEqual({
      kind: 'network',
      message: 'Check your internet connection and try again.',
      retryable: true,
    });
  });
});

describe('subscribeToProfile (real emulators)', () => {
  const waitFor = (
    subscribe: (onChange: (snapshot: ProfileSnapshot) => void) => () => void,
    predicate: (snapshot: ProfileSnapshot) => boolean,
    trigger?: () => Promise<unknown>,
  ) =>
    new Promise<ProfileSnapshot>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for the profile.')),
        15_000,
      );
      const unsubscribe = subscribe((snapshot) => {
        if (predicate(snapshot)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(snapshot);
        }
      });
      void trigger?.();
    });

  it('delivers the current profile and then follows a saved change', async () => {
    const { client, uid } = await verifiedPerson('PASSENGER', 'profile-live');
    const subscribe = (onChange: (snapshot: ProfileSnapshot) => void) =>
      subscribeToProfile(client, uid, onChange, (error) => {
        throw error;
      });

    const first = await waitFor(subscribe, (snapshot) => snapshot.status === 'ready');
    expect(first).toMatchObject({
      status: 'ready',
      profile: { name: 'Ada Lovelace', phone: null },
    });

    const updated = await waitFor(
      subscribe,
      (snapshot) => snapshot.status === 'ready' && snapshot.profile.name === 'Live Name',
      () => saveProfile(client, { name: 'Live Name', phone: '+44 7700 900123' }),
    );
    expect(updated).toMatchObject({ profile: { name: 'Live Name', phone: '+44 7700 900123' } });
  });

  it('reports a missing profile for an account that has none', async () => {
    const setup = createClient();
    const { user, uid } = await signUp(setup, 'profile-missing');
    await admin().auth.updateUser(uid, { emailVerified: true });
    await user.getIdToken(true);

    const snapshot = await waitFor(
      (onChange) =>
        subscribeToProfile(setup, uid, onChange, (error) => {
          throw error;
        }),
      () => true,
    );

    expect(snapshot).toEqual({ status: 'missing' });
    await signOut(setup.auth);
  });

  it('reports a permission error when the email is not verified', async () => {
    const setup = createClient();
    const email = uniqueEmail('profile-noread');
    const credential = await createUserWithEmailAndPassword(setup.auth, email, PASSWORD);

    const error = await new Promise<unknown>((resolve) => {
      const unsubscribe = subscribeToProfile(
        setup,
        credential.user.uid,
        () => undefined,
        (e) => {
          unsubscribe();
          resolve(e);
        },
      );
    });

    expect(describeAuthError(error).kind).toBe('permission');
  });
});
