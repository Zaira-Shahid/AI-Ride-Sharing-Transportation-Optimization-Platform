import { z } from 'zod';
import type { TripMonitoringRow } from './tripMonitoring';

// Module 11.10 (admin dashboard: payments). See functions/src/payments.ts's own comment for the scope
// this was checked and agreed against - the shapes here match what that function actually takes and
// returns.

export const PAYMENT_LIST_STATUSES = [
  'CAPTURED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type PaymentListStatus = (typeof PAYMENT_LIST_STATUSES)[number];

export const paymentsCursorSchema = z.object({
  seconds: z.number().int(),
  nanoseconds: z.number().int().min(0).max(999_999_999),
  tripId: z.string().trim().min(1).max(200),
});
export type PaymentsCursor = z.infer<typeof paymentsCursorSchema>;

export const listPaymentsInputSchema = z.object({
  paymentStatus: z.enum(PAYMENT_LIST_STATUSES).nullish(),
  cursor: paymentsCursorSchema.nullish(),
});
export type ListPaymentsInput = z.infer<typeof listPaymentsInputSchema>;

export const REFUND_REASON_MAX_LENGTH = 500;
export const refundPaymentInputSchema = z.object({
  tripId: z.string().trim().min(1).max(200),
  amountMinorUnits: z.number().positive().nullish(),
  reason: z.string().trim().min(1).max(REFUND_REASON_MAX_LENGTH),
});
export type RefundPaymentInput = z.infer<typeof refundPaymentInputSchema>;

export interface ListPaymentsResult {
  rows: TripMonitoringRow[];
  nextCursor: PaymentsCursor | null;
}

export interface PaymentsSummary {
  totalCapturedMinorUnits: number;
  totalRefundedMinorUnits: number;
  totalPlatformFeeMinorUnits: number;
}

export interface RefundPaymentResult {
  status: 'refunded' | 'failed' | 'skipped';
}
