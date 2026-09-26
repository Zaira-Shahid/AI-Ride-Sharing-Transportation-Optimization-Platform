import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';

// Module 9.5 (driver earnings): a per-trip ledger entry only - user-approved, no running total is
// maintained anywhere yet (a driver earnings screen or admin dashboard, neither built, would compute
// one by summing this collection). Written the moment a trip's payment is actually CAPTURED (module
// 9.4) - not merely on trip completion - matching the spec's own acceptance line order ("Complete trip
// -> automatic payment -> earnings record"): no money was actually collected until capture succeeds,
// so nothing is owed to the driver from it yet either. This is a bookkeeping figure only: no Stripe
// Connect account exists to actually pay a driver out (module 9.1's own deferred decision).

export interface DriverEarningRecord {
  driverId: string;
  tripId: string;
  amountMinorUnits: number;
  currency: string;
}

/**
 * Writes one driverEarnings entry inside an already-open transaction, alongside the same transaction
 * that marks the trip's payment CAPTURED (paymentCapture.ts) - the same "only ever created alongside
 * the real change it is about" pattern notifications.ts's own createNotification already follows.
 */
export function recordDriverEarning(
  tx: Transaction,
  firestore: Firestore,
  input: DriverEarningRecord,
): void {
  tx.create(firestore.collection('driverEarnings').doc(), {
    driverId: input.driverId,
    tripId: input.tripId,
    amountMinorUnits: input.amountMinorUnits,
    currency: input.currency,
    createdAt: FieldValue.serverTimestamp(),
  });
}
