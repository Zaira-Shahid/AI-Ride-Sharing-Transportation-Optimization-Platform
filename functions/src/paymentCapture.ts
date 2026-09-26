import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { recordDriverEarning } from './driverEarnings.js';
import { computeDriverEarningsMinorUnits, computeFareBreakdown } from './fare.js';
import { readFareConfig } from './fareConfig.js';
import { formatMinorUnits } from './money.js';
import { sendPushToUser } from './pushNotifications.js';
import type { PushProvider } from './pushProvider.js';
import { recordReceipt } from './receipts.js';
import type { StripeProvider } from './stripeProvider.js';

// Module 9.4 (payment capture): once a trip is COMPLETED and its final fare is known (Module 9.3),
// captures exactly finalFareMinorUnits from the hold Module 9.2 placed - never the full authorized
// amount, which included fare.ts's own AUTHORIZATION_BUFFER_PERCENT precisely so a lower amount could
// be captured later without a second authorization. A trip whose payment was never authorized (no
// paymentIntentId - the expected case today, since nothing is wired into the live match pipeline
// until a real card-entry UI exists) is simply skipped, the same "nothing to do here" stance
// authorizeTripPayment's own 'skipped' already takes.
//
// A capture failing AFTER the ride is already complete is a fundamentally different situation from an
// authorization declining before pickup (Module 9.2): there is no "back to the open pool" to fall
// back to - the passenger already got their ride. User-approved: mark paymentStatus FAILED and stop;
// a future module (webhooks, an admin dashboard, a retry/dunning flow) is what actually resolves it,
// not this one.
//
// A successful capture also writes a driverEarnings ledger entry (Module 9.5, driverEarnings.ts) -
// user-approved: only on an actual capture, matching the spec's own acceptance line order ("Complete
// trip -> automatic payment -> earnings record"). Skipped (not a failure) if the trip's own driverId
// or platformFeeMinorUnits is somehow missing - a bookkeeping gap, not a payment one.
//
// The same successful capture also writes a receipts entry (Module 9.8, receipts.ts) - the passenger's
// own fare breakdown, recomputed from the same estimatedDistance/estimatedDuration/sharedRide already
// used to reach finalFareMinorUnits in the first place (Module 9.3), never platformFeeMinorUnits
// (deliberately excluded from what a passenger's receipt shows).
//
// Module 10.4 (payment captured push): a successful capture also pushes both sides - the passenger
// (charged) and the driver (their own earnings entry just written, above) - each told the actual
// amount (money.ts's own formatMinorUnits, the first display-currency formatting in this codebase). A
// FAILED capture pushes nobody - user-approved: with no retry/card-update UI yet, a push about it would
// not be actionable for either side (the same "actionable and minimal" rule 8.9's own notifications
// already follow), so it stays a FAILED status + audit log for a future module to resolve.

export type PaymentCaptureOutcome = 'captured' | 'failed' | 'skipped';

/**
 * Captures `tripId`'s own held payment, if it needs capturing: only a COMPLETED trip with an
 * AUTHORIZED payment and a known final fare does (safe to call more than once - already
 * captured/failed/never-authorized trips are left alone, 'skipped').
 */
export async function captureTripPayment(
  deps: { firestore: Firestore; stripe: StripeProvider; push: PushProvider },
  tripId: string,
): Promise<PaymentCaptureOutcome> {
  const { firestore } = deps;
  const tripRef = firestore.collection('tripRequests').doc(tripId);
  const tripSnap = await tripRef.get();

  if (
    !tripSnap.exists ||
    tripSnap.get('status') !== 'COMPLETED' ||
    tripSnap.get('paymentStatus') !== 'AUTHORIZED'
  ) {
    return 'skipped';
  }

  const paymentIntentId = tripSnap.get('paymentIntentId');
  const finalFareMinorUnits = tripSnap.get('finalFareMinorUnits');
  if (
    typeof paymentIntentId !== 'string' ||
    !paymentIntentId ||
    typeof finalFareMinorUnits !== 'number'
  ) {
    return 'skipped';
  }

  const driverId = tripSnap.get('matchedDriverId');
  const platformFeeMinorUnits = tripSnap.get('platformFeeMinorUnits');
  const passengerId = tripSnap.get('passengerId');
  const estimatedDistance = tripSnap.get('estimatedDistance');
  const estimatedDuration = tripSnap.get('estimatedDuration');
  const sharedRide = tripSnap.get('sharedRide') === true;

  const [outcome, fareConfig] = await Promise.all([
    deps.stripe.capturePayment({ paymentIntentId, amountMinorUnits: finalFareMinorUnits }),
    readFareConfig(firestore),
  ]);

  const driverEarningsAmountMinorUnits =
    typeof driverId === 'string' && driverId && typeof platformFeeMinorUnits === 'number'
      ? computeDriverEarningsMinorUnits(finalFareMinorUnits, platformFeeMinorUnits)
      : null;

  const captured = await firestore.runTransaction(async (tx) => {
    const current = await tx.get(tripRef);
    if (!current.exists || current.get('paymentStatus') !== 'AUTHORIZED') return false;

    if (outcome.status === 'failed') {
      tx.update(tripRef, { paymentStatus: 'FAILED', updatedAt: FieldValue.serverTimestamp() });
      tx.create(firestore.collection('auditLogs').doc(), {
        timestamp: FieldValue.serverTimestamp(),
        actor: 'system',
        action: 'TRIP_PAYMENT_CAPTURE_FAILED',
        entity: `tripRequests/${tripId}`,
        previousState: { paymentStatus: 'AUTHORIZED' },
        newState: { paymentStatus: 'FAILED' },
        reason: 'Payment could not be captured',
      });
      return false;
    }

    tx.update(tripRef, { paymentStatus: 'CAPTURED', updatedAt: FieldValue.serverTimestamp() });
    if (driverEarningsAmountMinorUnits !== null && typeof driverId === 'string' && driverId) {
      recordDriverEarning(tx, firestore, {
        driverId,
        tripId,
        amountMinorUnits: driverEarningsAmountMinorUnits,
        currency: fareConfig.currency,
      });
    }
    if (
      typeof passengerId === 'string' &&
      passengerId &&
      typeof estimatedDistance === 'number' &&
      typeof estimatedDuration === 'number'
    ) {
      recordReceipt(tx, firestore, {
        passengerId,
        tripId,
        currency: fareConfig.currency,
        breakdown: computeFareBreakdown(
          fareConfig,
          estimatedDistance,
          estimatedDuration,
          sharedRide,
        ),
      });
    }
    return true;
  });

  if (captured) {
    // Module 10.4 (payment captured push): sent AFTER the transaction above commits (a network call,
    // never inside a Firestore transaction). sendPushToUser never throws and no-ops for anyone with
    // no saved token.
    const chargeAmount = formatMinorUnits(finalFareMinorUnits, fareConfig.currency);
    await Promise.all([
      typeof passengerId === 'string' && passengerId
        ? sendPushToUser(deps, passengerId, {
            title: 'Payment captured',
            body: `You were charged ${chargeAmount} for your trip.`,
          })
        : Promise.resolve(),
      driverEarningsAmountMinorUnits !== null && typeof driverId === 'string' && driverId
        ? sendPushToUser(deps, driverId, {
            title: 'You got paid',
            body: `You earned ${formatMinorUnits(driverEarningsAmountMinorUnits, fareConfig.currency)} for this trip.`,
          })
        : Promise.resolve(),
    ]);
  }

  return outcome.status === 'failed' ? 'failed' : 'captured';
}
