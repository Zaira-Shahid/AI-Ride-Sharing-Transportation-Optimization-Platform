import { z } from 'zod';

// Module 11.8 (admin dashboard: audit logs). Spec section 55 defines the entry shape (timestamp,
// actor, action, entity, previousState, newState, reason) and ends "Never store unnecessary
// sensitive information"; Phase 11's own module list gives only the name. Scoped via a plain-text
// exchange with the user: (a) ADMIN and SUPER_ADMIN only (the log records staff decisions, including
// who opened which trip), through a function - `auditLogs` has no Firestore rule; (b) loading the
// list is not itself audited; (c) newest first with cursor paging, an exact-action filter and an
// actor search (email, uid, `system` or `script:...`), with a deliberately small index set; (d) staff
// uids are resolved to a name/email through `users`, `system` and `script:` actors are shown as
// stored; (e) VEHICLE_CREATED/VEHICLE_UPDATED entries carry the whole vehicle (plate number
// included) in their stored states, so the function returns only WHICH fields changed for them - the
// stored entries are untouched; (f) `optimizationRunId` (in the spec's example, never written by any
// module), exports and any change to what other modules write are out of scope. Entries hold no
// exact place (docs/security.md), so nothing here tries to reconstruct one.

export const AUDIT_LOG_PAGE_SIZE = 25;

/** Actions whose stored states hold personal detail, so only the names of the changed fields go out. */
export const AUDIT_FIELDS_ONLY_ACTIONS = ['VEHICLE_CREATED', 'VEHICLE_UPDATED'] as const;

/**
 * Every action any module writes today - suggestions for the filter box, which still accepts any
 * exact action. tests/audit-actions.test.ts fails when a module writes one that is missing here.
 */
export const AUDIT_LOG_ACTIONS = [
  'DISPUTE_REVIEWED',
  'DRIVER_PROFILE_CREATED',
  'DRIVER_REVIEW_REQUESTED',
  'DRIVER_TAKEN_OFFLINE',
  'DRIVER_VERIFICATION_REVIEWED',
  'JOURNEY_CANCELLED_DRIVER_OFFLINE',
  'JOURNEY_CREATED',
  'JOURNEY_DELAY_CLEARED',
  'JOURNEY_DELAY_FLAGGED',
  'PLAN_REVISED',
  'ROLE_ASSIGNED',
  'TRIP_INSERTED_INTO_JOURNEY',
  'TRIP_PAYMENT_CAPTURE_FAILED',
  'TRIP_PAYMENT_DISPUTED',
  'TRIP_PAYMENT_REFUNDED',
  'TRIP_PAYMENT_REFUND_FAILED',
  'TRIP_PAYMENT_VOID_FAILED',
  'TRIP_PLACES_CLEARED',
  'TRIP_REQUEST_CANCELLED',
  'TRIP_REQUEST_CREATED',
  'TRIP_UNMATCHED_DRIVER_CANCELLED',
  'TRIP_UNMATCHED_PAYMENT_DECLINED',
  'TRIP_UNMATCHED_ROUTE_MODIFICATION',
  'TRIP_VIEWED_BY_STAFF',
  'USER_STATUS_CHANGED',
  'VEHICLE_CAPACITY_CHANGED',
  'VEHICLE_CREATED',
  'VEHICLE_REVIEW_REQUESTED',
  'VEHICLE_UPDATED',
  'VEHICLE_VERIFICATION_REVIEWED',
] as const;

export const auditLogCursorSchema = z.object({
  seconds: z.number().int(),
  nanoseconds: z.number().int().min(0).max(999_999_999),
  logId: z.string().trim().min(1).max(200),
});
export type AuditLogCursor = z.infer<typeof auditLogCursorSchema>;

export const listAuditLogsInputSchema = z.object({
  cursor: auditLogCursorSchema.nullish(),
  action: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z_]{0,79}$/)
    .nullish(),
  actor: z.string().trim().min(1).max(200).nullish(),
});
export type ListAuditLogsInput = z.infer<typeof listAuditLogsInputSchema>;

/** One audit entry as staff see it. Never holds an exact place, or a vehicle's own values. */
export interface AuditLogRow {
  logId: string;
  timestamp: number;
  actor: string;
  /** Set when the actor is a user account found in `users`; null for `system`, `script:...` or a deleted account. */
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  entity: string;
  reason: string | null;
  previousState: Record<string, unknown> | null;
  newState: Record<string, unknown> | null;
  /** Only for AUDIT_FIELDS_ONLY_ACTIONS: the names of the fields that changed (or were set), no values. */
  changedFields: string[] | null;
}

export interface ListAuditLogsResult {
  rows: AuditLogRow[];
  nextCursor: AuditLogCursor | null;
}
