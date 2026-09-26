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
  /** A passenger's open trip request (Module 3.7); set and cleared by server functions only. */
  currentTripRequestId?: string | null;
  /** An Expo push token (Module 10.2), kept up to date by the app; null until one is saved. */
  pushToken: string | null;
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
