import { describe, expect, it } from 'vitest';
import {
  describeAuthError,
  registerAccount,
  requestPasswordReset,
  signIn,
} from '../../packages/firebase/src';
import { AUTH_EMULATOR, PASSWORD, createClient, projectId, uniqueEmail } from './support';

const NEW_PASSWORD = 'a-brand-new-password';

async function resetCodesFor(email: string) {
  const response = await fetch(`${AUTH_EMULATOR}/emulator/v1/projects/${projectId}/oobCodes`);
  const { oobCodes } = (await response.json()) as {
    oobCodes: { email: string; oobCode: string; requestType: string }[];
  };
  return oobCodes.filter((code) => code.email === email && code.requestType === 'PASSWORD_RESET');
}

async function registeredEmail(prefix: string) {
  const client = createClient();
  const email = uniqueEmail(prefix);
  await registerAccount(client, {
    role: 'PASSENGER',
    values: { name: 'Ada', email, phone: '', password: PASSWORD, confirmPassword: PASSWORD },
  });
  return email;
}

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return describeAuthError(error);
  }
  throw new Error('Expected the promise to reject.');
}

describe('requestPasswordReset (real emulators)', () => {
  it('sends a reset link that really changes the password', async () => {
    const email = await registeredEmail('reset-flow');
    const client = createClient();

    await requestPasswordReset(client, { email });

    const codes = await resetCodesFor(email);
    expect(codes).toHaveLength(1);

    // What Firebase's hosted page does when the person chooses a new password.
    const applied = await fetch(
      `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=emulator-api-key`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oobCode: codes[0]?.oobCode, newPassword: NEW_PASSWORD }),
      },
    );
    expect(applied.ok).toBe(true);

    const signInAgain = createClient();
    const oldPassword = await failureOf(
      signIn(signInAgain, { values: { email, password: PASSWORD }, expectedRole: 'PASSENGER' }),
    );
    expect(oldPassword.kind).toBe('invalid-credential');

    const outcome = await signIn(createClient(), {
      values: { email, password: NEW_PASSWORD },
      expectedRole: 'PASSENGER',
    });
    expect(outcome.role).toBe('PASSENGER');
  });

  it('answers the same for an unknown address and sends nothing', async () => {
    const known = await registeredEmail('reset-known');
    const unknown = uniqueEmail('reset-nobody');

    const forKnown = await requestPasswordReset(createClient(), { email: known });
    const forUnknown = await requestPasswordReset(createClient(), { email: unknown });

    expect(forUnknown).toEqual(forKnown);
    expect(await resetCodesFor(unknown)).toHaveLength(0);
  });

  it('normalises the address before sending', async () => {
    const email = await registeredEmail('reset-case');
    await requestPasswordReset(createClient(), { email: `  ${email.toUpperCase()} ` });
    expect(await resetCodesFor(email)).toHaveLength(1);
  });

  it('rejects an invalid address without contacting Firebase', async () => {
    const failure = await failureOf(
      requestPasswordReset(createClient(), { email: 'not-an-email' }),
    );
    expect(failure).toMatchObject({ kind: 'invalid-email', retryable: false });
  });

  it('does not touch the signed-in state of the caller', async () => {
    const email = await registeredEmail('reset-session');
    const client = createClient();
    await signIn(client, { values: { email, password: PASSWORD }, expectedRole: 'PASSENGER' });

    await requestPasswordReset(client, { email });

    expect(client.auth.currentUser?.email).toBe(email);
  });
});
