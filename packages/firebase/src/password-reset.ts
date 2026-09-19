import { validatePasswordResetRequest } from '@ridemesh/types';
import { sendPasswordResetEmail } from 'firebase/auth';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

type Client = Pick<FirebaseClient, 'auth'>;

// Codes that would reveal whether an address has an account. They are treated as success so the
// screen gives the same answer either way.
const NEUTRAL_CODES = new Set(['auth/user-not-found', 'auth/user-disabled']);

/**
 * Asks Firebase to email a password reset link. Resolves the same way whether or not the address
 * belongs to an account, so the result cannot be used to discover which emails are registered.
 * The person then sets a new password on Firebase's hosted page and signs in again in the app.
 */
export async function requestPasswordReset(
  client: Client,
  input: { email: string },
): Promise<void> {
  const validation = validatePasswordResetRequest(input);
  if (!validation.ok) {
    throw new AuthFlowError('invalid-email', validation.errors.email);
  }

  try {
    await sendPasswordResetEmail(client.auth, validation.data.email);
  } catch (error) {
    if (NEUTRAL_CODES.has(getErrorCode(error) ?? '')) return;
    throw error;
  }
}
