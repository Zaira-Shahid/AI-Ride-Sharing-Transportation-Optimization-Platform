import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';

// Module 8.9 (notification): an in-app signal only - a Firestore `notifications` collection the
// recipient can read live, no Firebase Cloud Messaging (real push, background delivery) yet. That is
// Phase 10's own module 1, still entirely unbuilt (user-approved: build only what Phase 8's own
// dynamic re-optimization needs now, the same "don't build ahead of the phase that owns it" pattern
// as every earlier phase in this project - e.g. Module 4.1 GPS shipping before Maps billing existed).
//
// Scoped to Phase 8's own events only (user-approved), not the spec's full notification-types list
// (section 40) - the rest of that list belongs to the phases that actually produce those events
// (trip/payment/safety notifications are Phase 9/10's own modules, not built yet). Covered here:
// - Module 8.4 (insertion): the newly inserted passenger, AND every existing passenger whose plan
//   changed to fit them in - each with their own reason.
// - Module 8.5 (driver cancellation): a passenger released back to SEARCHING.
// - Module 8.6 (traffic delay): every currently matched passenger, when the flag newly turns on (not
//   when it clears - see the file's own note on "actionable and minimal": a delay is something to
//   react to, a return to normal pace is not).
// - Module 8.7 (route modification): every passenger KEPT in a successful reorder (their driver's
//   route changed after a delay), and any passenger DROPPED by it (released, same as 8.5/8.8).
// No notification is written when nothing actually changed for anyone (an insertion candidate or a
// reorder that was never applied) - only a real, committed change produces one.

export const NOTIFICATION_TYPES = [
  'MATCHED_INTO_SHARED_RIDE',
  'ROUTE_ADJUSTED_FOR_NEW_PASSENGER',
  'RELEASED_TO_SEARCHING',
  'DRIVER_DELAYED',
  'ROUTE_UPDATED_AFTER_DELAY',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationInput {
  recipientId: string;
  type: NotificationType;
  /** A short, plain-language, actionable message (spec section 40: "actionable and minimal"). */
  message: string;
  /** e.g. `tripRequests/{id}` or `driverJourneys/{id}` - what this notification is about. */
  relatedEntity: string;
}

/**
 * Writes one notification inside an already-open transaction, alongside whatever else that
 * transaction is already committing - every call site above only ever creates one once its own real
 * change is also being written, never on its own. `read` starts false; nothing here marks it read
 * (a later screen/module's own job).
 */
export function createNotification(
  tx: Transaction,
  firestore: Firestore,
  input: NotificationInput,
): void {
  tx.create(firestore.collection('notifications').doc(), {
    recipientId: input.recipientId,
    type: input.type,
    message: input.message,
    relatedEntity: input.relatedEntity,
    read: false,
    createdAt: FieldValue.serverTimestamp(),
  });
}
