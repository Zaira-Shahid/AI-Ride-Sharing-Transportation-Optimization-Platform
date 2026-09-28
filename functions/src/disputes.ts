import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { isStaffRole } from './roles.js';
import { toRow, type TripMonitoringRow } from './tripMonitoring.js';
import type { StaffCaller } from './verification.js';

// Module 11.7 (admin dashboard: disputes). See packages/types/src/disputes.ts's own comment for the
// scope this was checked and agreed against. Shares tripMonitoring.ts's own toRow (no exact place in
// a list row) and the same "staff read tripRequests only through a scoped function, never a blanket
// rule" shape (docs/security.md) - a genuinely different module (Phase 11's own module 9, distinct
// from module 6's trip monitoring) that happens to read the same collection the same way.

const DISPUTED_TRIPS_LIMIT = 200;

export const markDisputeReviewedInputSchema = z.object({
  tripId: z.string().trim().min(1).max(200),
});

export interface DisputedTripRow extends TripMonitoringRow {
  disputeReviewed: boolean;
}

export type MarkDisputeReviewedResult = { status: 'reviewed' | 'unchanged' };

function requireStaff(caller: StaffCaller): void {
  if (!isStaffRole(caller.role) || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'You are not allowed to view disputes.');
  }
}

/** Every trip whose payment is currently DISPUTED, newest first. Not audited (no exact place is here). */
export async function listDisputedTripsForStaff(
  deps: { firestore: Firestore },
  caller: StaffCaller,
): Promise<DisputedTripRow[]> {
  requireStaff(caller);
  const snapshot = await deps.firestore
    .collection('tripRequests')
    .where('paymentStatus', '==', 'DISPUTED')
    .orderBy('createdAt', 'desc')
    .limit(DISPUTED_TRIPS_LIMIT)
    .get();
  return snapshot.docs.map((doc) => ({
    ...toRow(doc.id, doc.data()),
    disputeReviewed: doc.get('disputeReviewed') === true,
  }));
}

/**
 * Marks a disputed trip as looked at - a work-queue marker only, never a payment state change (the
 * payment state machine, spec section 74, has nothing after DISPUTED). Any staff role may call this
 * (unlike a financial decision, this carries no risk beyond tracking); audited like every other
 * status change in this codebase, but names no place.
 */
export async function markDisputeReviewedForStaff(
  deps: { firestore: Firestore },
  caller: StaffCaller,
  rawInput: unknown,
): Promise<MarkDisputeReviewedResult> {
  requireStaff(caller);
  const parsed = markDisputeReviewedInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The request is not valid.');
  }
  const { tripId } = parsed.data;

  const { firestore } = deps;
  const ref = firestore.collection('tripRequests').doc(tripId);

  return firestore.runTransaction(async (tx): Promise<MarkDisputeReviewedResult> => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) {
      throw new HttpsError('not-found', 'There is no trip with that ID.');
    }
    if (snapshot.get('paymentStatus') !== 'DISPUTED') {
      throw new HttpsError('failed-precondition', 'This trip is not currently disputed.');
    }
    if (snapshot.get('disputeReviewed') === true) return { status: 'unchanged' };

    tx.update(ref, { disputeReviewed: true, updatedAt: FieldValue.serverTimestamp() });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: 'DISPUTE_REVIEWED',
      entity: `tripRequests/${tripId}`,
      previousState: { disputeReviewed: false },
      newState: { disputeReviewed: true },
      reason: 'Staff marked this dispute as reviewed',
    });
    return { status: 'reviewed' };
  });
}
