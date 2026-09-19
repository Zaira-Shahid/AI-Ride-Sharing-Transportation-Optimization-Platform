export type SessionStatus = 'loading' | 'signedOut' | 'unverified' | 'incomplete' | 'ready';

export interface SessionInput {
  signedIn: boolean;
  emailVerified: boolean;
  /** The role custom claim from the ID token, if the server has assigned one. */
  role: string | null;
}

/**
 * - signedOut: nobody is signed in
 * - unverified: signed in, email not verified yet
 * - incomplete: email verified but registration never finished (no role assigned)
 * - ready: signed in, verified and with a server-assigned role
 */
export function deriveSessionStatus(input: SessionInput): Exclude<SessionStatus, 'loading'> {
  if (!input.signedIn) return 'signedOut';
  if (!input.emailVerified) return 'unverified';
  if (input.role === null) return 'incomplete';
  return 'ready';
}
