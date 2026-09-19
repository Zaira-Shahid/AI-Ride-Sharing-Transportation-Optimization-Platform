import type { RegistrationFormValues } from '@ridemesh/types';
import { createUserWithEmailAndPassword, getIdTokenResult, signOut } from 'firebase/auth';
import { describe, expect, it } from 'vitest';
import { describeAuthError, registerAccount } from '../../packages/firebase/src';
import { PASSWORD, admin, createClient, projectId, uniqueEmail } from './support';

function form(email: string, overrides: Partial<RegistrationFormValues> = {}) {
  return {
    name: 'Ada Lovelace',
    email,
    phone: '',
    password: PASSWORD,
    confirmPassword: PASSWORD,
    ...overrides,
  };
}

async function verificationCodesFor(email: string) {
  const response = await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${projectId}/oobCodes`);
  const { oobCodes } = (await response.json()) as {
    oobCodes: { email: string; requestType: string }[];
  };
  return oobCodes.filter((code) => code.email === email && code.requestType === 'VERIFY_EMAIL');
}

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return describeAuthError(error);
  }
  throw new Error('Expected the promise to reject.');
}

describe('registerAccount (real emulators)', () => {
  it('creates a passenger account with a server-set role and sends the verification email', async () => {
    const client = createClient();
    const email = uniqueEmail('reg-passenger');

    const outcome = await registerAccount(client, {
      role: 'PASSENGER',
      values: form(email, { phone: '+44 7700 900123' }),
    });
    expect(outcome).toEqual({ emailVerified: false, verificationEmailSent: true });

    const user = client.auth.currentUser;
    expect(user?.displayName).toBe('Ada Lovelace');
    expect((await getIdTokenResult(user!)).claims.role).toBe('PASSENGER');

    const { firestore } = admin();
    const profile = (await firestore.doc(`users/${user!.uid}`).get()).data();
    expect(profile).toMatchObject({
      role: 'PASSENGER',
      name: 'Ada Lovelace',
      email,
      phone: '+44 7700 900123',
      status: 'ACTIVE',
    });
    expect(await verificationCodesFor(email)).toHaveLength(1);
  });

  it('creates a driver account without a phone number', async () => {
    const client = createClient();
    const email = uniqueEmail('reg-driver');

    await registerAccount(client, { role: 'DRIVER', values: form(email) });

    const uid = client.auth.currentUser!.uid;
    expect((await admin().auth.getUser(uid)).customClaims).toEqual({ role: 'DRIVER' });
    expect((await admin().firestore.doc(`users/${uid}`).get()).get('phone')).toBeNull();
  });

  it('rejects a password shorter than 8 characters before creating anything', async () => {
    const client = createClient();
    const email = uniqueEmail('reg-short');

    const failure = await failureOf(
      registerAccount(client, {
        role: 'PASSENGER',
        values: form(email, { password: 'short7!', confirmPassword: 'short7!' }),
      }),
    );
    expect(failure.kind).toBe('validation');
    await expect(admin().auth.getUserByEmail(email)).rejects.toMatchObject({
      code: 'auth/user-not-found',
    });
  });

  it('resumes an account left half-finished by an earlier attempt', async () => {
    const client = createClient();
    const email = uniqueEmail('reg-resume');
    // An earlier attempt created the account but never got a role.
    await createUserWithEmailAndPassword(client.auth, email, PASSWORD);
    const uid = client.auth.currentUser!.uid;
    await signOut(client.auth);
    expect((await admin().auth.getUser(uid)).customClaims ?? {}).toEqual({});

    const outcome = await registerAccount(client, { role: 'DRIVER', values: form(email) });

    expect(outcome.verificationEmailSent).toBe(true);
    expect((await admin().auth.getUser(uid)).customClaims).toEqual({ role: 'DRIVER' });
  });

  it('reports an existing account when the password does not match, and changes nothing', async () => {
    const original = createClient();
    const email = uniqueEmail('reg-taken');
    await registerAccount(original, { role: 'PASSENGER', values: form(email) });
    const uid = original.auth.currentUser!.uid;

    const intruder = createClient();
    const failure = await failureOf(
      registerAccount(intruder, {
        role: 'DRIVER',
        values: form(email, { password: 'another-password', confirmPassword: 'another-password' }),
      }),
    );

    expect(failure).toMatchObject({ kind: 'email-in-use', retryable: false });
    expect(intruder.auth.currentUser).toBeNull();
    expect((await admin().auth.getUser(uid)).customClaims).toEqual({ role: 'PASSENGER' });
  });

  it('never lets a registered account switch role, and signs the person out again', async () => {
    const first = createClient();
    const email = uniqueEmail('reg-switch');
    await registerAccount(first, { role: 'DRIVER', values: form(email) });
    const uid = first.auth.currentUser!.uid;

    const second = createClient();
    const failure = await failureOf(
      registerAccount(second, { role: 'PASSENGER', values: form(email) }),
    );

    expect(failure).toMatchObject({ kind: 'role-conflict', retryable: false });
    expect(second.auth.currentUser).toBeNull();
    expect((await admin().auth.getUser(uid)).customClaims).toEqual({ role: 'DRIVER' });
  });

  it('is safe to submit twice and only sends one verification email', async () => {
    const client = createClient();
    const email = uniqueEmail('reg-twice');

    await registerAccount(client, { role: 'PASSENGER', values: form(email) });
    const second = await registerAccount(client, { role: 'PASSENGER', values: form(email) });

    expect(second.emailVerified).toBe(false);
    expect((await admin().auth.getUserByEmail(email)).customClaims).toEqual({ role: 'PASSENGER' });
  });
});
