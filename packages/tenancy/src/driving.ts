import { z } from 'zod';
import { REVIEW_REASON_MAX_LENGTH, REVIEW_TARGETS } from '@ridemesh/types';

// Inputs and results for the driving capability (module A2b, docs/a2b-driver-capability-design.md).
// Mirrored in functions/src/employeeDriving.ts; tests/tenancy-parity.test.ts fails if they diverge.

const uidSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,128}$/);
const targetSchema = z.enum(REVIEW_TARGETS);
const reasonSchema = z.string().trim().min(1).max(REVIEW_REASON_MAX_LENGTH);

export const APPLICATIONS_LIST_LIMIT = 100;
export const APPLY_TO_DRIVE_PER_HOUR = 10;

export const approveEmployeeDriverInputSchema = z.object({ uid: uidSchema });
export type ApproveEmployeeDriverInput = z.infer<typeof approveEmployeeDriverInputSchema>;

export const rejectEmployeeDriverInputSchema = z.object({
  uid: uidSchema,
  target: targetSchema,
  reason: reasonSchema,
});
export type RejectEmployeeDriverInput = z.infer<typeof rejectEmployeeDriverInputSchema>;

export const revokeEmployeeDriverInputSchema = z.object({ uid: uidSchema, reason: reasonSchema });
export type RevokeEmployeeDriverInput = z.infer<typeof revokeEmployeeDriverInputSchema>;

export type VerificationStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

export interface ApplyToDriveResult {
  status: 'applied' | 'unchanged';
}

/** An applicant as their company's administrator sees them. Nothing about trips or places. */
export interface DriverApplicationRow {
  uid: string;
  name: string | null;
  email: string | null;
  requestedAt: number | null;
  driverStatus: VerificationStatus | null;
  driverReason: string | null;
  vehicle: {
    type: string;
    make: string;
    model: string;
    plateNumber: string;
    seatCapacity: number | null;
    status: VerificationStatus;
    reason: string | null;
  } | null;
  /** True when something is waiting for a decision: a vehicle exists and a part is still PENDING. */
  needsReview: boolean;
}

export interface ListDriverApplicationsResult {
  rows: DriverApplicationRow[];
}

export interface ApproveEmployeeDriverResult {
  status: 'approved' | 'unchanged';
}

export interface RejectEmployeeDriverResult {
  status: 'rejected' | 'unchanged';
}

export interface RevokeEmployeeDriverResult {
  status: 'revoked' | 'unchanged';
}
