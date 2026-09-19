import { APP_DISPLAY_NAMES } from '@ridemesh/config';
import { validateLogin, type LoginFormValues, type SelfServiceRole } from '@ridemesh/types';
import { signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { AuthFlowError } from './auth-errors';
import type { FirebaseClient } from './client';

type Client = Pick<FirebaseClient, 'auth'>;

export interface SignInInput {
  values: LoginFormValues;
  /** The role this app serves. An account with a different role is refused. */
  expectedRole: SelfServiceRole;
}

export interface SignInOutcome {
  /** The server-assigned role, or null if registration was never finished. */
  role: string | null;
}

export function roleMismatchMessage(role: string): string {
  if (role === 'PASSENGER') {
    return `This is a passenger account. Please sign in with the ${APP_DISPLAY_NAMES.passenger} app.`;
  }
  if (role === 'DRIVER') {
    return `This is a driver account. Please sign in with the ${APP_DISPLAY_NAMES.driver} app.`;
  }
  return 'This account cannot be used in this app.';
}

/**
 * Signs in with email and password.
 *
 * An account whose server-assigned role belongs to a different app is signed out again and
 * refused with a clear message. This keeps people in the right app; it is not an access control
 * (rules and functions authorize from the role claim). Accounts with no role yet, or with an
 * unverified email, are let through so the app can guide them to finish registration or verify.
 */
export async function signIn(client: Client, input: SignInInput): Promise<SignInOutcome> {
  const validation = validateLogin(input.values);
  if (!validation.ok) {
    throw new AuthFlowError('validation', 'Please check the highlighted fields.');
  }
  const { email, password } = validation.data;

  const credential = await signInWithEmailAndPassword(client.auth, email, password);
  const { claims } = await credential.user.getIdTokenResult();
  const role = typeof claims.role === 'string' ? claims.role : null;

  if (role !== null && role !== input.expectedRole) {
    await signOut(client.auth).catch(() => undefined);
    throw new AuthFlowError('role-mismatch', roleMismatchMessage(role));
  }
  return { role };
}
