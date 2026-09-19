import { z } from 'zod';

// Staff who may verify or reject a driver or a vehicle. The four staff roles are otherwise
// read-only; per-role permissions for the rest are defined in the admin module (Phase 11).
export const REVIEWER_ROLES = ['ADMIN', 'SUPER_ADMIN'] as const;

export const REVIEW_DECISIONS = ['VERIFIED', 'REJECTED'] as const;
export const reviewDecisionSchema = z.enum(REVIEW_DECISIONS);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const REVIEW_TARGETS = ['DRIVER', 'VEHICLE'] as const;
export const reviewTargetSchema = z.enum(REVIEW_TARGETS);
export type ReviewTarget = z.infer<typeof reviewTargetSchema>;

export const REVIEW_REASON_MAX_LENGTH = 500;

/** A staff decision on one driver, or on that driver's vehicle. A rejection needs a reason. */
export const reviewInputSchema = z
  .object({
    // A Firebase uid: no slashes or dots, so it cannot point at another path.
    driverId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,128}$/),
    decision: reviewDecisionSchema,
    // null is accepted because the Firebase SDK sends an omitted field as null.
    reason: z.string().trim().max(REVIEW_REASON_MAX_LENGTH).nullish(),
  })
  .refine((input) => input.decision !== 'REJECTED' || (input.reason ?? '').length > 0, {
    path: ['reason'],
    message: 'A rejection needs a reason.',
  });
export type ReviewInput = z.infer<typeof reviewInputSchema>;

export interface ReviewResult {
  status: 'reviewed' | 'unchanged';
}

/** A driver asking for a rejected driver profile or vehicle to be looked at again. */
export const requestReviewInputSchema = z.object({ target: reviewTargetSchema });
export type RequestReviewInput = z.infer<typeof requestReviewInputSchema>;

export interface RequestReviewResult {
  status: 'requested' | 'unchanged';
}
