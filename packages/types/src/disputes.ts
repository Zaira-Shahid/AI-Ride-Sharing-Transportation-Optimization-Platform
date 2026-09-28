import { z } from 'zod';

// Module 11.7 (admin dashboard: disputes). Scoped via a plain-text exchange with the user, same
// pattern as trip monitoring (module 11.4): (a) visibility only for this pass - no refund action here,
// since issuing one is its own financial/business decision deserving a separate design pass, even
// though functions/src/paymentRefund.ts's refundTripPayment already exists (built module 9.7, never
// wired to a caller); (b) a lightweight "mark reviewed" work-queue marker (audit-only, no payment
// state change - the payment state machine, spec section 74, has nothing after DISPUTED); (c) scoped
// to paymentStatus === 'DISPUTED' only - Stripe's own dispute-closed (won/lost) follow-up webhook
// isn't handled anywhere yet (module 9.9 only ever handles charge.dispute.created), a separate later
// item.

export const markDisputeReviewedInputSchema = z.object({
  tripId: z.string().trim().min(1).max(200),
});
export type MarkDisputeReviewedInput = z.infer<typeof markDisputeReviewedInputSchema>;

export interface MarkDisputeReviewedResult {
  status: 'reviewed' | 'unchanged';
}
