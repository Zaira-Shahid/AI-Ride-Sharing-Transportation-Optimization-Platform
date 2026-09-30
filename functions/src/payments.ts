import { AggregateField, FieldPath, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { isStaffRole } from './roles.js';
import type { StripeProvider } from './stripeProvider.js';
import { toRow, type TripMonitoringRow } from './tripMonitoring.js';
import { refundTripPayment } from './paymentRefund.js';
import { REVIEWER_ROLES, type StaffCaller } from './verification.js';

// Module 11.10 (admin dashboard: payments). docs/security.md's own boundary for tripRequests applies
// here too: this is another audited access point, not a Firestore rule. Checked against the spec:
// section 22 names the "Payments" page but gives it no detail (the same gap 11.2/11.3/11.6 had);
// section 74 gives the payment state machine's own 7 states. Scoped via a plain-text exchange with
// the user, after checking the code for what Disputes (11.7) does NOT already cover: (a) a list of
// trips by payment status, defaulting to CAPTURED/FAILED/REFUNDED/PARTIALLY_REFUNDED (DISPUTED stays
// Disputes' own page; PENDING/AUTHORIZED are pre-completion, Trip Monitoring's own live view) - no new
// data model, every payment field already lives on the trip request itself; (b) refundTripPayment
// (module 9.7) was fully built and tested but never wired to a caller - its own file header says
// exactly that ("build and test the logic now, wire it into a real trigger once one exists") - this is
// that trigger, restricted to REVIEWER_ROLES like every other financial/verification decision (any
// staff role may still view the page, the same "SUPPORT/OPERATIONS see the queue, only reviewers act"
// split module 11.3 already uses); (c) a platform-wide totals summary (captured/refunded/platform fee)
// - totals only, no trend or time breakdown, which stays Phase 12's own job (its own metrics list
// names "payment success rate" as an Analytics concern, not this page's).

export const PAYMENT_LIST_PAGE_SIZE = 25;
export const PAYMENT_LIST_STATUSES = [
  'CAPTURED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type PaymentListStatus = (typeof PAYMENT_LIST_STATUSES)[number];

export const listPaymentsInputSchema = z.object({
  paymentStatus: z.enum(PAYMENT_LIST_STATUSES).nullish(),
  cursor: z
    .object({
      seconds: z.number().int(),
      nanoseconds: z.number().int().min(0).max(999_999_999),
      tripId: z.string().trim().min(1).max(200),
    })
    .nullish(),
});

export const REFUND_REASON_MAX_LENGTH = 500;
export const refundPaymentInputSchema = z.object({
  tripId: z.string().trim().min(1).max(200),
  /** Defaults to a full refund (refundTripPayment's own default) when left out. */
  amountMinorUnits: z.number().positive().nullish(),
  reason: z.string().trim().min(1).max(REFUND_REASON_MAX_LENGTH),
});

export interface ListPaymentsResult {
  rows: TripMonitoringRow[];
  nextCursor: { seconds: number; nanoseconds: number; tripId: string } | null;
}

export interface PaymentsSummary {
  /** Sum of finalFareMinorUnits over every trip ever captured (CAPTURED, REFUNDED or PARTIALLY_REFUNDED) - unaffected by a later refund, the same as the stored field itself. */
  totalCapturedMinorUnits: number;
  /** Sum of refundedAmountMinorUnits over REFUNDED/PARTIALLY_REFUNDED trips. */
  totalRefundedMinorUnits: number;
  /** Sum of platformFeeMinorUnits over every trip ever captured - a refund never reverses the fee (docs/security.md, module 9.7's own policy). */
  totalPlatformFeeMinorUnits: number;
}

export type RefundPaymentResult = { status: 'refunded' | 'failed' | 'skipped' };

function requireStaff(caller: StaffCaller): void {
  if (!isStaffRole(caller.role) || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'You are not allowed to view payments.');
  }
}

function requireReviewer(caller: StaffCaller): void {
  const allowed = (REVIEWER_ROLES as readonly unknown[]).includes(caller.role);
  if (!allowed || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'You are not allowed to issue a refund.');
  }
}

/** Trips by payment status, newest first, paginated - the same shape as listTripHistory (module 11.4). */
export async function listPaymentsForStaff(
  deps: { firestore: Firestore },
  caller: StaffCaller,
  rawInput: unknown,
): Promise<ListPaymentsResult> {
  requireStaff(caller);
  const parsed = listPaymentsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The request is not valid.');
  }
  const statuses = parsed.data.paymentStatus ? [parsed.data.paymentStatus] : PAYMENT_LIST_STATUSES;

  let query = deps.firestore
    .collection('tripRequests')
    .where('paymentStatus', 'in', [...statuses])
    .orderBy('createdAt', 'desc')
    .orderBy(FieldPath.documentId(), 'desc')
    .limit(PAYMENT_LIST_PAGE_SIZE);

  const cursor = parsed.data.cursor;
  if (cursor) {
    query = query.startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.tripId);
  }

  const snapshot = await query.get();
  const rows = snapshot.docs.map((doc) => toRow(doc.id, doc.data()));
  const last = snapshot.docs.at(-1);
  const lastTimestamp = last?.get('createdAt') as Timestamp | undefined;
  const nextCursor =
    rows.length === PAYMENT_LIST_PAGE_SIZE && last && lastTimestamp
      ? { seconds: lastTimestamp.seconds, nanoseconds: lastTimestamp.nanoseconds, tripId: last.id }
      : null;
  return { rows, nextCursor };
}

/** Platform-wide totals only - no trend or time breakdown (Phase 12's own job). */
export async function getPaymentsSummaryForStaff(
  deps: { firestore: Firestore },
  caller: StaffCaller,
): Promise<PaymentsSummary> {
  requireStaff(caller);
  const { firestore } = deps;
  const capturedEver = firestore
    .collection('tripRequests')
    .where('paymentStatus', 'in', ['CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED']);
  const refunded = firestore
    .collection('tripRequests')
    .where('paymentStatus', 'in', ['REFUNDED', 'PARTIALLY_REFUNDED']);

  const [capturedAgg, feeAgg, refundedAgg] = await Promise.all([
    capturedEver.aggregate({ total: AggregateField.sum('finalFareMinorUnits') }).get(),
    capturedEver.aggregate({ total: AggregateField.sum('platformFeeMinorUnits') }).get(),
    refunded.aggregate({ total: AggregateField.sum('refundedAmountMinorUnits') }).get(),
  ]);

  return {
    totalCapturedMinorUnits: capturedAgg.data().total ?? 0,
    totalPlatformFeeMinorUnits: feeAgg.data().total ?? 0,
    totalRefundedMinorUnits: refundedAgg.data().total ?? 0,
  };
}

/**
 * Issues a refund on an already-captured payment, full or partial. ADMIN/SUPER_ADMIN only - a
 * financial decision, unlike the list/summary above. Requires a reason, folded into the audit entry
 * refundTripPayment itself already writes, alongside the real staff uid as the actor.
 */
export async function refundPaymentAsStaff(
  deps: { firestore: Firestore; stripe: StripeProvider },
  caller: StaffCaller,
  rawInput: unknown,
): Promise<RefundPaymentResult> {
  requireReviewer(caller);
  const parsed = refundPaymentInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The request is not valid.');
  }
  const { tripId, amountMinorUnits, reason } = parsed.data;
  const status = await refundTripPayment(
    deps,
    tripId,
    amountMinorUnits ?? undefined,
    caller.uid,
    reason,
  );
  return { status };
}
