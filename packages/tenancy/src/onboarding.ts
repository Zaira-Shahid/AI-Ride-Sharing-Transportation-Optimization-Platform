import { z } from 'zod';
import { companyRoleSchema } from './claims';

// Inputs, limits and results for company onboarding (module A2a, docs/a2-company-onboarding-design.md).
// Mirrored in functions/src/companies.ts; tests/tenancy-parity.test.ts fails if the two diverge.

export const COMPANY_NAME_MAX = 100;
export const PERSON_NAME_MAX = 100;
export const PHONE_MAX = 32;
/** Longest valid email address (RFC 5321). */
export const EMAIL_MAX = 254;

export const COMPANY_CREATIONS_PER_ACCOUNT_PER_DAY = 3;
export const INVITES_PER_ADMIN_PER_HOUR = 30;
export const MAX_PENDING_INVITATIONS = 200;
export const EMPLOYEES_PAGE_SIZE = 50;
export const INVITATIONS_LIST_LIMIT = 100;

const nameSchema = z.string().trim().min(1).max(PERSON_NAME_MAX);
const phoneSchema = z.string().trim().min(1).max(PHONE_MAX).nullish();
const documentIdSchema = z.string().trim().min(1).max(128);

export const createCompanyInputSchema = z.object({
  name: z.string().trim().min(2).max(COMPANY_NAME_MAX),
  ownerName: nameSchema,
  phone: phoneSchema,
});
export type CreateCompanyInput = z.infer<typeof createCompanyInputSchema>;

export const inviteEmployeeInputSchema = z.object({
  email: z.string().trim().toLowerCase().max(EMAIL_MAX).pipe(z.email()),
  // null (what the Firebase client sends for an undefined field) means the default.
  companyRole: companyRoleSchema.nullish().transform((role) => role ?? 'EMPLOYEE'),
});
export type InviteEmployeeInput = z.infer<typeof inviteEmployeeInputSchema>;

export const acceptInvitationInputSchema = z.object({
  code: z.string().trim().min(1).max(200),
  name: nameSchema,
  phone: phoneSchema,
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationInputSchema>;

export const revokeInvitationInputSchema = z.object({ invitationId: documentIdSchema });
export type RevokeInvitationInput = z.infer<typeof revokeInvitationInputSchema>;

export const listEmployeesInputSchema = z.object({ cursor: documentIdSchema.nullish() });
export type ListEmployeesInput = z.infer<typeof listEmployeesInputSchema>;

export const removeEmployeeInputSchema = z.object({ uid: documentIdSchema });
export type RemoveEmployeeInput = z.infer<typeof removeEmployeeInputSchema>;

export const setEmployeeRoleInputSchema = z.object({
  uid: documentIdSchema,
  companyRole: companyRoleSchema,
});
export type SetEmployeeRoleInput = z.infer<typeof setEmployeeRoleInputSchema>;

export interface CreateCompanyResult {
  companyId: string;
  status: 'created' | 'unchanged';
}

export interface InviteEmployeeResult {
  invitationId: string;
  /** Shown once. The admin shares it; the server keeps only a hash. */
  code: string;
  expiresAt: number;
}

export type InvitationListStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

/** One invitation as its company's admin sees it. Never holds the code or its hash. */
export interface InvitationRow {
  invitationId: string;
  email: string;
  companyRole: 'COMPANY_ADMIN' | 'EMPLOYEE';
  status: InvitationListStatus;
  createdAt: number;
  expiresAt: number;
}

export interface ListInvitationsResult {
  rows: InvitationRow[];
}

export interface RevokeInvitationResult {
  status: 'revoked' | 'unchanged';
}

export interface AcceptInvitationResult {
  companyId: string;
  companyRole: 'COMPANY_ADMIN' | 'EMPLOYEE';
  status: 'accepted' | 'unchanged';
}

export interface EmployeeRow {
  uid: string;
  name: string | null;
  email: string | null;
  companyRole: 'COMPANY_ADMIN' | 'EMPLOYEE';
  status: 'ACTIVE' | 'REMOVED';
  canDrive: boolean;
  joinedAt: number | null;
}

export interface ListEmployeesResult {
  rows: EmployeeRow[];
  nextCursor: string | null;
}

export interface RemoveEmployeeResult {
  status: 'removed' | 'unchanged';
}

export interface SetEmployeeRoleResult {
  status: 'changed' | 'unchanged';
}
