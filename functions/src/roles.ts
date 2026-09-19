// Functions deploy from this directory alone, so these constants intentionally mirror
// @ridemesh/types. tests/roles-parity.test.ts fails if the two ever diverge.
export const SELF_SERVICE_ROLES = ['PASSENGER', 'DRIVER'] as const;
export const STAFF_ROLES = ['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN'] as const;

export type SelfServiceRole = (typeof SELF_SERVICE_ROLES)[number];
export type StaffRole = (typeof STAFF_ROLES)[number];

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === 'string' && (STAFF_ROLES as readonly string[]).includes(value);
}
