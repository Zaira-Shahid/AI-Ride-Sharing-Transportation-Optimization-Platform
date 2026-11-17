import { z } from 'zod';

export const USER_ROLES = [
  'PASSENGER',
  'DRIVER',
  'SUPPORT',
  'OPERATIONS',
  'ADMIN',
  'SUPER_ADMIN',
  'EMPLOYEE',
] as const;

export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

// Roles a person may choose for themselves at sign-up. Staff roles are only ever assigned
// server-side by a service-account script and can never be requested from a client.
export const SELF_SERVICE_ROLES = ['PASSENGER', 'DRIVER'] as const;
export const selfServiceRoleSchema = z.enum(SELF_SERVICE_ROLES);
export type SelfServiceRole = z.infer<typeof selfServiceRoleSchema>;

export const STAFF_ROLES = ['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN'] as const;
export const staffRoleSchema = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof staffRoleSchema>;

// The platform role of a company member (Product A, docs/a1-tenancy-design.md). Like staff roles it
// can never be requested from a client: it is set only by server code when someone accepts a company
// invitation. What a member may do inside the company is `companyRole`, in @ridemesh/tenancy.
export const COMPANY_MEMBER_PLATFORM_ROLES = ['EMPLOYEE'] as const;

export function isStaffRole(role: string | undefined | null): role is StaffRole {
  return staffRoleSchema.safeParse(role).success;
}
