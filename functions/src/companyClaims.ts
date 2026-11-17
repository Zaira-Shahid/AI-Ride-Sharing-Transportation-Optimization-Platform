import type { Auth } from 'firebase-admin/auth';

// Functions deploy from this directory alone, so these constants intentionally mirror
// @ridemesh/tenancy and @ridemesh/types. tests/tenancy-parity.test.ts fails if they diverge.
export const COMPANY_ROLES = ['COMPANY_ADMIN', 'EMPLOYEE'] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];
export const COMPANY_MEMBER_PLATFORM_ROLE = 'EMPLOYEE';

/** A company claim change that must be refused, with a message safe to show the caller. */
export class CompanyClaimsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyClaimsError';
  }
}

export type ClaimsAuth = Pick<Auth, 'getUser' | 'setCustomUserClaims' | 'revokeRefreshTokens'>;

function isCompanyRole(value: unknown): value is CompanyRole {
  return typeof value === 'string' && (COMPANY_ROLES as readonly string[]).includes(value);
}

/**
 * Makes an account a company member by setting its company claims, keeping every unrelated claim.
 * Refuses an account that already has a different platform role (a consumer or a staff member:
 * one account is either a consumer or a company member) and an account already in another company
 * (one company per employee). Setting the same company again is allowed, so a retry is safe.
 * The new claims reach the person at their next token refresh.
 */
export async function setCompanyClaims(
  auth: ClaimsAuth,
  uid: string,
  input: { companyId: string; companyRole: CompanyRole },
): Promise<void> {
  if (typeof input.companyId !== 'string' || input.companyId.length === 0) {
    throw new CompanyClaimsError('A company is required.');
  }
  if (!isCompanyRole(input.companyRole)) {
    throw new CompanyClaimsError('That company role is not valid.');
  }

  const user = await auth.getUser(uid);
  const claims = user.customClaims ?? {};
  const existingRole: unknown = claims.role;
  if (existingRole !== undefined && existingRole !== COMPANY_MEMBER_PLATFORM_ROLE) {
    throw new CompanyClaimsError('This account already has a role and cannot join a company.');
  }
  const existingCompany: unknown = claims.companyId;
  if (existingCompany !== undefined && existingCompany !== input.companyId) {
    throw new CompanyClaimsError('This account already belongs to another company.');
  }

  await auth.setCustomUserClaims(uid, {
    ...claims,
    role: COMPANY_MEMBER_PLATFORM_ROLE,
    companyId: input.companyId,
    companyRole: input.companyRole,
  });
}

/**
 * Removes the company claims (and the EMPLOYEE role) and revokes refresh tokens so the person
 * cannot keep refreshing a token that still names the company. Every unrelated claim is kept.
 * Returns false, doing nothing, for an account that had no company claims.
 */
export async function clearCompanyClaims(auth: ClaimsAuth, uid: string): Promise<boolean> {
  const user = await auth.getUser(uid);
  const claims = { ...(user.customClaims ?? {}) };
  if (claims.companyId === undefined && claims.companyRole === undefined) return false;

  delete claims.companyId;
  delete claims.companyRole;
  if (claims.role === COMPANY_MEMBER_PLATFORM_ROLE) delete claims.role;

  await auth.setCustomUserClaims(uid, claims);
  await auth.revokeRefreshTokens(uid);
  return true;
}
