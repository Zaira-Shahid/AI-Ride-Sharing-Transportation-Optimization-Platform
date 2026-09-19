import { createUserWithEmailAndPassword, getIdTokenResult, signOut } from 'firebase/auth';
import { describe, expect, it } from 'vitest';
import {
  describeAuthError,
  registerAccount,
  signIn,
  type SignInInput,
} from '../../packages/firebase/src';
import { PASSWORD, admin, createClient, uniqueEmail, type Client } from './support';

async function registered(role: 'PASSENGER' | 'DRIVER', prefix: string) {
  const client = createClient();
  const email = uniqueEmail(prefix);
  await registerAccount(client, {
    role,
    values: { name: 'Ada', email, phone: '', password: PASSWORD, confirmPassword: PASSWORD },
  });
  const uid = client.auth.currentUser!.uid;
  await signOut(client.auth);
  return { email, uid };
}

const attempt = (
  client: Client,
  email: string,
  password: string,
  role: SignInInput['expectedRole'],
) => signIn(client, { values: { email, password }, expectedRole: role });

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return describeAuthError(error);
  }
  throw new Error('Expected the promise to reject.');
}

describe('signIn (real emulators)', () => {
  it('signs a passenger in to the passenger app and returns the server-assigned role', async () => {
    const { email, uid } = await registered('PASSENGER', 'in-passenger');
    const client = createClient();

    const outcome = await attempt(client, email, PASSWORD, 'PASSENGER');

    expect(outcome).toEqual({ role: 'PASSENGER' });
    expect(client.auth.currentUser?.uid).toBe(uid);
    expect((await getIdTokenResult(client.auth.currentUser!)).claims.role).toBe('PASSENGER');
  });

  it('signs a driver in to the driver app', async () => {
    const { email } = await registered('DRIVER', 'in-driver');
    const client = createClient();
    expect(await attempt(client, email, PASSWORD, 'DRIVER')).toEqual({ role: 'DRIVER' });
  });

  it('normalises the email address', async () => {
    const { email } = await registered('PASSENGER', 'in-case');
    const client = createClient();
    await attempt(client, `  ${email.toUpperCase()} `, PASSWORD, 'PASSENGER');
    expect(client.auth.currentUser?.email).toBe(email);
  });

  it('refuses a wrong password and stays signed out', async () => {
    const { email } = await registered('PASSENGER', 'in-wrong');
    const client = createClient();

    const failure = await failureOf(attempt(client, email, 'not-the-password', 'PASSENGER'));

    expect(failure).toMatchObject({ kind: 'invalid-credential', retryable: false });
    expect(client.auth.currentUser).toBeNull();
  });

  it('gives the same answer for an unknown email as for a wrong password', async () => {
    const { email } = await registered('PASSENGER', 'in-enumeration');
    const wrongPassword = await failureOf(
      attempt(createClient(), email, 'not-the-password', 'PASSENGER'),
    );
    const unknownEmail = await failureOf(
      attempt(createClient(), uniqueEmail('nobody'), 'not-the-password', 'PASSENGER'),
    );
    expect(unknownEmail).toEqual(wrongPassword);
  });

  it('refuses a driver account in the passenger app with a clear message, and signs out', async () => {
    const { email } = await registered('DRIVER', 'in-cross-driver');
    const client = createClient();

    const failure = await failureOf(attempt(client, email, PASSWORD, 'PASSENGER'));

    expect(failure).toEqual({
      kind: 'role-mismatch',
      message: 'This is a driver account. Please sign in with the RideMesh Driver app.',
      retryable: false,
    });
    expect(client.auth.currentUser).toBeNull();
  });

  it('refuses a passenger account in the driver app with a clear message, and signs out', async () => {
    const { email } = await registered('PASSENGER', 'in-cross-passenger');
    const client = createClient();

    const failure = await failureOf(attempt(client, email, PASSWORD, 'DRIVER'));

    expect(failure.message).toBe(
      'This is a passenger account. Please sign in with the RideMesh app.',
    );
    expect(client.auth.currentUser).toBeNull();
  });

  it('refuses a staff account in either app without naming the role', async () => {
    const { email, uid } = await registered('PASSENGER', 'in-staff');
    await admin().auth.setCustomUserClaims(uid, { role: 'ADMIN' });

    for (const app of ['PASSENGER', 'DRIVER'] as const) {
      const client = createClient();
      const failure = await failureOf(attempt(client, email, PASSWORD, app));
      expect(failure).toMatchObject({
        kind: 'role-mismatch',
        message: 'This account cannot be used in this app.',
      });
      expect(client.auth.currentUser).toBeNull();
    }
  });

  it('lets an account with no role yet through, so registration can be finished', async () => {
    const setup = createClient();
    const email = uniqueEmail('in-norole');
    await createUserWithEmailAndPassword(setup.auth, email, PASSWORD);
    await signOut(setup.auth);

    const client = createClient();
    expect(await attempt(client, email, PASSWORD, 'PASSENGER')).toEqual({ role: null });
    expect(client.auth.currentUser).not.toBeNull();
  });

  it('lets an unverified account through, so the app can ask for verification', async () => {
    const { email } = await registered('DRIVER', 'in-unverified');
    const client = createClient();
    await attempt(client, email, PASSWORD, 'DRIVER');
    expect(client.auth.currentUser?.emailVerified).toBe(false);
  });

  it('reports a disabled account clearly', async () => {
    const { email, uid } = await registered('PASSENGER', 'in-disabled');
    await admin().auth.updateUser(uid, { disabled: true });

    const failure = await failureOf(attempt(createClient(), email, PASSWORD, 'PASSENGER'));

    expect(failure).toMatchObject({ kind: 'account-disabled', retryable: false });
  });

  it('validates the form before contacting Firebase', async () => {
    const client = createClient();
    const failure = await failureOf(attempt(client, 'not-an-email', '', 'PASSENGER'));
    expect(failure.kind).toBe('validation');
    expect(client.auth.currentUser).toBeNull();
  });
});
