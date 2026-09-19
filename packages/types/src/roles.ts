import { z } from 'zod';

export const USER_ROLES = [
  'PASSENGER',
  'DRIVER',
  'SUPPORT',
  'OPERATIONS',
  'ADMIN',
  'SUPER_ADMIN',
] as const;

export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;
