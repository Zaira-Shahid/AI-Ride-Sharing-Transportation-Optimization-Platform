import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { FareBreakdown } from './fare.js';

// Module 9.8 (receipts): a per-trip, immutable receipt record - user-approved, the same "backend
// record only, no UI screen yet" scope as driverEarnings.ts's own module 9.5 (no passenger-facing
// receipts screen exists in apps/passenger; a future one would just read this collection). Written the
// moment a trip's payment is actually CAPTURED (module 9.4), alongside the same driverEarnings entry -
// matching the spec's own flow diagram order ("Payment finalized -> Receipt"). Deliberately does NOT
// include platformFeeMinorUnits (user-approved) - an internal split, not something a passenger-facing
// receipt shows; tripRequests already has that field for staff/backend use if ever needed.

export interface ReceiptRecord {
  passengerId: string;
  tripId: string;
  currency: string;
  breakdown: FareBreakdown;
}

/**
 * Writes one receipts entry inside an already-open transaction, alongside the same transaction that
 * marks the trip's payment CAPTURED (paymentCapture.ts) - the same "only ever created alongside the
 * real change it is about" pattern notifications.ts's own createNotification already follows. Once
 * written, a receipt is never updated or deleted by anything in this codebase (a refund, module 9.7,
 * leaves it as it is - it recorded what was actually charged at the time, not a running balance).
 */
export function recordReceipt(tx: Transaction, firestore: Firestore, input: ReceiptRecord): void {
  tx.create(firestore.collection('receipts').doc(), {
    passengerId: input.passengerId,
    tripId: input.tripId,
    currency: input.currency,
    baseFareMinorUnits: input.breakdown.baseFareMinorUnits,
    distanceTimeComponentMinorUnits: input.breakdown.distanceTimeComponentMinorUnits,
    sharedRideDiscountMinorUnits: input.breakdown.sharedRideDiscountMinorUnits,
    totalMinorUnits: input.breakdown.totalMinorUnits,
    createdAt: FieldValue.serverTimestamp(),
  });
}
