import { z } from 'zod';
import { COMPANY_MEMBER_PLATFORM_ROLES } from '@ridemesh/types';
import { COMPANY_ROLES, type CompanyRole } from './company';

// The identity of a company member, as carried in the signed token (docs/a1-tenancy-design.md,
// section 2). Set only by server code. The driving capability is deliberately NOT here: it is read
// from the membership document, so changing it never needs a token refresh.

export const companyRoleSchema = z.enum(COMPANY_ROLES);

export const companyClaimsSchema = z.object({
  role: z.literal(COMPANY_MEMBER_PLATFORM_ROLES[0]),
  companyId: z.string().min(1).max(128),
  companyRole: companyRoleSchema,
});
export type CompanyClaims = z.infer<typeof companyClaimsSchema>;

/**
 * Reads company claims from a decoded token or `getIdTokenResult().claims`. Returns null unless the
 * token carries all three claims in a valid combination, so a half-set or consumer token is never
 * mistaken for a company member.
 */
export function parseCompanyClaims(claims: unknown): CompanyClaims | null {
  const result = companyClaimsSchema.safeParse(claims);
  return result.success ? result.data : null;
}

export function isCompanyAdmin(claims: CompanyClaims | null): boolean {
  return claims?.companyRole === 'COMPANY_ADMIN';
}

export type { CompanyRole };
