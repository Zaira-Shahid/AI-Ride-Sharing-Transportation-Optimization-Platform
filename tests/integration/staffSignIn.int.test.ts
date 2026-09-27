import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import { describeAuthError, signInStaff } from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail, PASSWORD } from './support';

// Module 11.1 (admin dashboard foundation): signInStaff's own logic, tested directly against the real
// Auth emulator - the same "call the function directly" approach every other push/auth module's own
// tests already take. Staff accounts are made the way scripts/set-staff-role.mjs makes one (a
// server-set role claim via the Admin SDK), never through completeRegistration.

async function staffAccount(prefix: string, role: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await admin().auth.setCustomUserClaims(uid, { role });
  await verifyEmail(user, email);
  return { client, uid, email };
}

async function selfServiceAccount(role: 'PASSENGER' | 'DRIVER', prefix: string) {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await httpsCallable(client.functions, 'completeRegistration')({ role, name: 'Test Person' });
  await verifyEmail(user, email);
  return { client, uid, email };
}

describe('signInStaff (functions + firestore + auth emulators)', () => {
  it.each(['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN'] as const)(
    'signs in a %s account and reports their role',
    async (role) => {
      const { client, email } = await staffAccount(`staff-${role.toLowerCase()}`, role);

      const outcome = await signInStaff(client, { email, password: PASSWORD });

      expect(outcome).toEqual({ role });
    },
  );

  it('refuses a passenger account and signs them out', async () => {
    const { client, email } = await selfServiceAccount('PASSENGER', 'staff-refuse-passenger');

    await expect(signInStaff(client, { email, password: PASSWORD })).rejects.toMatchObject({
      message: 'This account cannot be used in the admin console.',
    });
    expect(client.auth.currentUser).toBeNull();
  });

  it('refuses a driver account and signs them out', async () => {
    const { client, email } = await selfServiceAccount('DRIVER', 'staff-refuse-driver');

    await expect(signInStaff(client, { email, password: PASSWORD })).rejects.toMatchObject({
      message: 'This account cannot be used in the admin console.',
    });
    expect(client.auth.currentUser).toBeNull();
  });

  it('refuses an account with no role assigned yet', async () => {
    const client = createClient();
    const { user, email } = await signUp(client, 'staff-refuse-norole');
    await verifyEmail(user, email);

    await expect(signInStaff(client, { email, password: PASSWORD })).rejects.toMatchObject({
      message: 'This account cannot be used in the admin console.',
    });
    expect(client.auth.currentUser).toBeNull();
  });

  it('gives the same clear message for a wrong password as the self-service sign-in does', async () => {
    const { client, email } = await staffAccount('staff-wrong-password', 'ADMIN');

    const error = await signInStaff(client, { email, password: 'definitely-wrong' }).catch(
      (caught: unknown) => caught,
    );

    expect(describeAuthError(error).message).toBe('Incorrect email or password.');
  });
});
