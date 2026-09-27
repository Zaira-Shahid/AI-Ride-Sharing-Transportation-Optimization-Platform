import { z } from 'zod';
import { userStatusSchema } from './user';

// Module 11.3 (admin dashboard: user management). Phase 11's own module list (section 61) gives no
// detail beyond the bare name; the only other spec mention is section 22's separate "Passengers" nav
// page. USER_STATUSES' own SUSPENDED value already gates every passenger/driver action across this
// codebase (tripRequests, journeys, locations, paymentMethods, verification's requestReview all check
// status === 'ACTIVE') but until this module nothing ever WROTE it outside a test fixture - this is
// that missing write path, scoped to passenger accounts only (drivers keep their own
// verification-driven offline lifecycle, see verification.ts's reviewVerification).

export const SET_USER_STATUS_REASON_MAX_LENGTH = 500;

/** A staff decision to suspend or reinstate a passenger account. Suspending needs a reason. */
export const setUserStatusInputSchema = z
  .object({
    // A Firebase uid: no slashes or dots, so it cannot point at another path.
    userId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,128}$/),
    status: userStatusSchema,
    // null is accepted because the Firebase SDK sends an omitted field as null.
    reason: z.string().trim().max(SET_USER_STATUS_REASON_MAX_LENGTH).nullish(),
  })
  .refine((input) => input.status !== 'SUSPENDED' || (input.reason ?? '').length > 0, {
    path: ['reason'],
    message: 'A suspension needs a reason.',
  });
export type SetUserStatusInput = z.infer<typeof setUserStatusInputSchema>;

export interface SetUserStatusResult {
  status: 'changed' | 'unchanged';
}
