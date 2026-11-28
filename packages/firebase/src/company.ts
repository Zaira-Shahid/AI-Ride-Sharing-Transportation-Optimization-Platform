import {
  isCompanyAdmin,
  parseCompanyClaims,
  type CompanyOverview,
  type CreateCompanyInput,
  type CreateCompanyResult,
  type UpdateCompanySettingsInput,
  type UpdateCompanySettingsResult,
} from '@ridemesh/tenancy';
import {
  validateLogin,
  validateRegistration,
  type LoginFormValues,
  type RegistrationFormValues,
} from '@ridemesh/types';
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode, type AuthErrorKind } from './auth-errors';
import type { FirebaseClient } from './client';

// The company console's side of the company functions (module A4a, docs/a4-company-dashboard-design.md).
// Deliberately NOT exported from the package index: it is imported as '@ridemesh/firebase/company',
// so the mobile apps' bundles never pull in the company model.

type Client = Pick<FirebaseClient, 'auth' | 'functions'>;

export const COMPANY_CONSOLE_REFUSAL = 'This account cannot use the company console.';

/**
 * What a signed-in account may do in the company console, from its token claims. Only a company
 * administrator gets in. An account with no role yet is on its way to creating a company. Anything
 * else (a passenger, a driver, platform staff, an ordinary employee, a half-set token) is refused.
 * This decides what to draw; every function still checks the membership document on the server.
 */
export type CompanyConsoleAccess = 'needs-company' | 'admin' | 'refused';

export function companyConsoleAccess(claims: unknown): CompanyConsoleAccess {
  const role =
    typeof claims === 'object' && claims !== null ? (claims as { role?: unknown }).role : undefined;
  if (role === undefined || role === null) return 'needs-company';
  return isCompanyAdmin(parseCompanyClaims(claims)) ? 'admin' : 'refused';
}

async function accessOf(user: User): Promise<CompanyConsoleAccess> {
  return companyConsoleAccess((await user.getIdTokenResult()).claims);
}

/**
 * Creates the administrator's account and sends the verification email. The company comes later,
 * once the email is verified (createCompany). Details left from an earlier attempt that did not
 * finish are resumed when the password is right; an account that already belongs to someone else's
 * product (a passenger, a driver, an employee) is not touched.
 */
export async function registerCompanyAccount(
  client: Client,
  values: Pick<RegistrationFormValues, 'name' | 'email' | 'password' | 'confirmPassword'>,
): Promise<{ emailVerified: boolean; verificationEmailSent: boolean }> {
  const validation = validateRegistration({ ...values, phone: '' });
  if (!validation.ok) {
    throw new AuthFlowError('validation', 'Please check the highlighted fields.');
  }
  const { name, email, password } = validation.data;

  let user: User;
  let resumed = false;
  try {
    user = (await createUserWithEmailAndPassword(client.auth, email, password)).user;
  } catch (error) {
    if (getErrorCode(error) !== 'auth/email-already-in-use') throw error;
    try {
      user = (await signInWithEmailAndPassword(client.auth, email, password)).user;
      resumed = true;
    } catch {
      throw error;
    }
  }

  try {
    if (resumed && (await accessOf(user)) === 'refused') {
      await signOut(client.auth).catch(() => undefined);
      throw new AuthFlowError('email-in-use', 'An account with this email address already exists.');
    }
    if (!user.displayName) await updateProfile(user, { displayName: name }).catch(() => undefined);
    if (user.emailVerified) return { emailVerified: true, verificationEmailSent: false };
    try {
      await sendEmailVerification(user);
      return { emailVerified: false, verificationEmailSent: true };
    } catch {
      return { emailVerified: false, verificationEmailSent: false };
    }
  } catch (error) {
    await signOut(client.auth).catch(() => undefined);
    throw error;
  }
}

/** Sends the verification email again. */
export async function resendVerificationEmail(client: Pick<FirebaseClient, 'auth'>): Promise<void> {
  const user = client.auth.currentUser;
  if (!user) throw new AuthFlowError('permission', 'Please sign in again.');
  await sendEmailVerification(user);
}

/**
 * Signs in to the company console. An account that already has a role other than company
 * administrator is signed out again and refused; one with no role yet is let through to verify its
 * email or create its company.
 */
export async function signInCompanyAdmin(
  client: Client,
  values: LoginFormValues,
): Promise<{ access: CompanyConsoleAccess }> {
  const validation = validateLogin(values);
  if (!validation.ok) {
    throw new AuthFlowError('validation', 'Please check the highlighted fields.');
  }
  const { email, password } = validation.data;
  const credential = await signInWithEmailAndPassword(client.auth, email, password);
  const access = await accessOf(credential.user);
  if (access === 'refused') {
    await signOut(client.auth).catch(() => undefined);
    throw new AuthFlowError('role-mismatch', COMPANY_CONSOLE_REFUSAL);
  }
  return { access };
}

// A company function's own refusal is already written for the person to read, so it is kept
// instead of being replaced by the generic wording describeAuthError would give.
const REFUSAL_KINDS: Record<string, AuthErrorKind> = {
  'permission-denied': 'permission',
  'failed-precondition': 'validation',
  'invalid-argument': 'validation',
  'resource-exhausted': 'too-many-requests',
  'not-found': 'validation',
  'already-exists': 'validation',
};

async function callCompany<Input, Output>(
  client: Pick<FirebaseClient, 'functions'>,
  name: string,
  data: Input,
): Promise<Output> {
  try {
    return (await httpsCallable<Input, Output>(client.functions, name)(data)).data;
  } catch (error) {
    const code = getErrorCode(error)?.replace(/^functions\//, '');
    const kind = code ? REFUSAL_KINDS[code] : undefined;
    if (kind && error instanceof Error && error.message) {
      throw new AuthFlowError(kind, error.message);
    }
    throw error;
  }
}

/** Creates the company with the signed-in, verified account as its first administrator. */
export async function createCompany(
  client: Client,
  input: CreateCompanyInput,
): Promise<CreateCompanyResult> {
  const result = await callCompany<CreateCompanyInput, CreateCompanyResult>(
    client,
    'createCompany',
    input,
  );
  // The new claims arrive with a fresh token.
  await client.auth.currentUser?.getIdToken(true);
  return result;
}

/** The overview's counts. Nothing about trips or places. */
export function getCompanyOverview(client: Pick<FirebaseClient, 'functions'>) {
  return callCompany<Record<string, never>, CompanyOverview>(client, 'getCompanyOverview', {});
}

export function updateCompanySettings(
  client: Pick<FirebaseClient, 'functions'>,
  input: UpdateCompanySettingsInput,
) {
  return callCompany<UpdateCompanySettingsInput, UpdateCompanySettingsResult>(
    client,
    'updateCompanySettings',
    input,
  );
}
