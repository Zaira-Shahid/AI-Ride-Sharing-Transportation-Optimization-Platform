import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// A company invitation code is "<invitationId>.<token>" (docs/a2-company-onboarding-design.md).
// The token is 32 random bytes shown to the admin once; only its SHA-256 hash is ever stored. The
// id lets the server find the invitation without querying by hash.

const ID_PATTERN = /^[A-Za-z0-9]{10,40}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface GeneratedInvitationCode {
  /** What the admin shares. Never stored and never logged. */
  code: string;
  /** What is stored on the invitation. */
  tokenHash: string;
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateInvitationCode(invitationId: string): GeneratedInvitationCode {
  const token = randomBytes(32).toString('base64url');
  return { code: `${invitationId}.${token}`, tokenHash: hashInvitationToken(token) };
}

/** Splits a shared code into its parts, or null when it is not shaped like one. */
export function parseInvitationCode(raw: unknown): { invitationId: string; token: string } | null {
  if (typeof raw !== 'string') return null;
  const [invitationId, token, ...rest] = raw.trim().split('.');
  if (rest.length > 0 || invitationId === undefined || token === undefined) return null;
  if (!ID_PATTERN.test(invitationId) || !TOKEN_PATTERN.test(token)) return null;
  return { invitationId, token };
}

/** Compares a presented token with a stored hash without leaking where they differ. */
export function tokenMatchesHash(token: string, storedHash: unknown): boolean {
  if (typeof storedHash !== 'string') return false;
  const presented = Buffer.from(hashInvitationToken(token), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}
