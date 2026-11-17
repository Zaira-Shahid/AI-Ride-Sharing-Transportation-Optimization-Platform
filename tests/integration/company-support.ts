import { signInWithEmailAndPassword } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { expect } from 'vitest';
import type {
  AcceptInvitationResult,
  CreateCompanyResult,
  InviteEmployeeResult,
} from '../../packages/tenancy/src';
import { PASSWORD, admin, createClient, signUp, verifyEmail, type Client } from './support';

// Helpers shared by the company integration tests (modules A2a and A2b): accounts, a founder with a
// company, invited and joined employees, and the Firestore and Auth reads the tests check.

export const call = (client: Client, name: string, data?: unknown) =>
  httpsCallable(client.functions, name)(data);
export const result = async <T>(client: Client, name: string, data?: unknown) =>
  (await call(client, name, data)).data as T;

export const refused = (code: string, message?: string) => ({
  code: `functions/${code}`,
  ...(message ? { message: expect.stringContaining(message) as unknown as string } : {}),
});

export interface Account {
  client: Client;
  uid: string;
  email: string;
  user: Awaited<ReturnType<typeof signUp>>['user'];
}

export async function account(prefix: string, verified = true): Promise<Account> {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  if (verified) await verifyEmail(user, email);
  return { client, uid, email, user };
}

/** A verified account that has created a company, with its token refreshed to carry the claims. */
export async function founder(prefix: string, name = 'Acme Ltd') {
  const acc = await account(prefix);
  const created = await result<CreateCompanyResult>(acc.client, 'createCompany', {
    name,
    ownerName: 'Founder Person',
  });
  await acc.user.getIdToken(true);
  return { ...acc, companyId: created.companyId };
}
export type Founder = Awaited<ReturnType<typeof founder>>;

export async function invite(
  by: Founder,
  email: string,
  companyRole?: 'COMPANY_ADMIN' | 'EMPLOYEE',
) {
  return result<InviteEmployeeResult>(by.client, 'inviteEmployee', { email, companyRole });
}

/** A new account invited by `by` and joined as `companyRole`, token refreshed. */
export async function joined(
  by: Founder,
  prefix: string,
  companyRole?: 'COMPANY_ADMIN' | 'EMPLOYEE',
) {
  const acc = await account(prefix);
  const { code } = await invite(by, acc.email, companyRole);
  await result<AcceptInvitationResult>(acc.client, 'acceptInvitation', {
    code,
    name: 'New Person',
  });
  await acc.user.getIdToken(true);
  return { ...acc, companyId: by.companyId };
}

/** A removed person's tokens are revoked, so they sign in again for a fresh one. */
export const signBackIn = async (acc: Account) => {
  await signInWithEmailAndPassword(acc.client.auth, acc.email, PASSWORD);
};

export const firestore = () => admin().firestore;
export const doc = async (path: string) => (await firestore().doc(path).get()).data();
export const claimsOf = async (uid: string) => (await admin().auth.getUser(uid)).customClaims ?? {};
export const auditOf = async (entity: string, action: string) =>
  (
    await firestore()
      .collection('auditLogs')
      .where('entity', '==', entity)
      .where('action', '==', action)
      .get()
  ).docs;
