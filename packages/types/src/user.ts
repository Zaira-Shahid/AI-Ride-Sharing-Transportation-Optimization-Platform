import { z } from 'zod';
import { selfServiceRoleSchema, type UserRole } from './roles';

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

export interface FirestoreTimestamp {
  seconds: number;
  nanoseconds: number;
  toDate(): Date;
}

// users/{userId}. Written only by server-side code; clients can never write this document.
// Authorization uses the verified `role` custom claim, never this field.
export interface UserProfile {
  role: UserRole;
  name: string;
  email: string;
  phone: string | null;
  photoUrl: string | null;
  status: UserStatus;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
}

export const completeRegistrationInputSchema = z.object({
  role: selfServiceRoleSchema,
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(1).max(32).optional(),
});
export type CompleteRegistrationInput = z.infer<typeof completeRegistrationInputSchema>;

export interface CompleteRegistrationResult {
  role: z.infer<typeof selfServiceRoleSchema>;
}
