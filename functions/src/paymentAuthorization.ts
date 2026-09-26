import { FieldValue, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { computeAuthorizationAmountMinorUnits, computeFareMinorUnits } from './fare.js';
import { readFareConfig } from './fareConfig.js';
import { createNotification } from './notifications.js';
import type { StripeProvider } from './stripeProvider.js';

// Module 9.2 (payment authorization): given one just-matched trip request, holds (capture_method:
// manual - module 9.4's own capture is what actually takes the money) the estimated fare plus a safety
// buffer (fare.ts) against the passenger's saved payment method. User-approved: authorization happens
// at MATCH time, not at request creation - an unmatched or since-cancelled request never has anything
// held against it - and this is NOT yet wired into the real match pipeline (6.9's matchIntoAvailable
// Journeys, 8.4's tryInsertIntoMatchingJourney): with no card-entry UI built yet, nobody can save a
// payment method, so wiring this in live today would bounce every match straight back to SEARCHING.
// Build and test the logic now; wire it into a real trigger once a real card-entry UI exists.
//
// A passenger with no saved payment method, or whose card is declined, is released back to SEARCHING
// (user-approved) - the same "back to the open pool" pattern modules 8.5/8.7/8.8 already use, with its
// own notification (module 8.9) telling them why. Unlike a driver going offline (8.5), the driver here
// did nothing wrong and is still online, so their journey goes back to AVAILABLE, not DRAFT - a fresh
// candidate for matching again, not taken out of the pool.
//
// KNOWN ACCEPTED GAP (documented, not fixed here - same spirit as module 5.5's own accepted gaps): if
// the released passenger was one of SEVERAL sharing an already-MATCHING journey's plan (module 8.4's
// own insertion), the journey correctly keeps the others and stays MATCHING, but the existing plan
// document still lists the declined passenger's own stops - nobody reads them (their own trip request
// no longer points at that plan), but the plan's own totals are now slightly wrong for anyone
// re-deriving them. A full re-plan on a payment decline is Module 8.7-sized work, out of scope here;
// authorization firing this soon after a match, this is expected to be rare in practice (only ever the
// single most-recently-matched passenger, essentially never one of several matched together).

const REORDERABLE_STATUS = 'PICKUP_ASSIGNED';

export type PaymentAuthorizationOutcome = 'authorized' | 'declined' | 'skipped';

/**
 * Releases `trip` (not yet picked up, payment could not be authorized) back to SEARCHING, removes it
 * from its journey's own matchedTripRequestIds, and reverts that journey to AVAILABLE if it now has no
 * other matched passenger - all in one transaction, plus the usual audit entry and notification.
 */
async function releaseUnauthorizedTrip(
  firestore: Firestore,
  trip: DocumentSnapshot,
  passengerId: string,
): Promise<void> {
  const journeyId = trip.get('matchedJourneyId');
  const journeyRef =
    typeof journeyId === 'string' && journeyId
      ? firestore.collection('driverJourneys').doc(journeyId)
      : null;

  await firestore.runTransaction(async (tx) => {
    const [currentTrip, currentJourney] = await Promise.all([
      tx.get(trip.ref),
      journeyRef ? tx.get(journeyRef) : Promise.resolve(null),
    ]);
    if (!currentTrip.exists || currentTrip.get('status') !== REORDERABLE_STATUS) return;

    tx.update(trip.ref, {
      status: 'SEARCHING',
      matchedJourneyId: null,
      matchedDriverId: null,
      driverName: null,
      vehicleType: null,
      vehicleMake: null,
      vehicleModel: null,
      vehiclePlateNumber: null,
      driverLocation: null,
      driverDelay: null,
      assignedPlanId: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: 'system',
      action: 'TRIP_UNMATCHED_PAYMENT_DECLINED',
      entity: `tripRequests/${trip.id}`,
      previousState: { status: REORDERABLE_STATUS },
      newState: { status: 'SEARCHING' },
      reason: 'Payment could not be authorized',
    });
    createNotification(tx, firestore, {
      recipientId: passengerId,
      type: 'RELEASED_TO_SEARCHING',
      message: 'Your payment could not be authorized. We are looking for a new match for you.',
      relatedEntity: `tripRequests/${trip.id}`,
    });

    if (currentJourney?.exists) {
      const matchedIds = currentJourney.get('matchedTripRequestIds');
      const remaining = (Array.isArray(matchedIds) ? matchedIds : []).filter(
        (id) => id !== trip.id,
      );
      if (remaining.length === 0) {
        tx.update(currentJourney.ref, {
          status: 'AVAILABLE',
          matchedTripRequestIds: remaining,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        tx.update(currentJourney.ref, {
          matchedTripRequestIds: remaining,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }
  });
}

/**
 * Authorizes `tripId`'s own fare, if it needs one: only a trip freshly at PICKUP_ASSIGNED with no
 * authorization already on it does (safe to call more than once - already-authorized or no-longer-
 * matched requests are left alone, 'skipped'). 'declined' covers both an actual Stripe decline and
 * having no payment method saved at all - either way the passenger is released, see the file's own note.
 */
export async function authorizeTripPayment(
  deps: { firestore: Firestore; stripe: StripeProvider },
  tripId: string,
): Promise<PaymentAuthorizationOutcome> {
  const { firestore } = deps;
  const tripRef = firestore.collection('tripRequests').doc(tripId);
  const tripSnap = await tripRef.get();
  if (
    !tripSnap.exists ||
    tripSnap.get('status') !== REORDERABLE_STATUS ||
    tripSnap.get('paymentIntentId') != null
  ) {
    return 'skipped';
  }

  const passengerId = tripSnap.get('passengerId');
  const estimatedDistance = tripSnap.get('estimatedDistance');
  const estimatedDuration = tripSnap.get('estimatedDuration');
  if (
    typeof passengerId !== 'string' ||
    !passengerId ||
    typeof estimatedDistance !== 'number' ||
    typeof estimatedDuration !== 'number'
  ) {
    return 'skipped';
  }

  const fareConfig = await readFareConfig(firestore);
  const estimatedFare = computeFareMinorUnits(fareConfig, estimatedDistance, estimatedDuration);
  const authorizationAmount = computeAuthorizationAmountMinorUnits(
    fareConfig,
    estimatedDistance,
    estimatedDuration,
  );

  const userSnap = await firestore.collection('users').doc(passengerId).get();
  const stripeCustomerId = userSnap.get('stripeCustomerId');
  const paymentMethodId = userSnap.get('paymentMethodId');

  const outcome =
    typeof stripeCustomerId === 'string' && typeof paymentMethodId === 'string'
      ? await deps.stripe.authorizePayment({
          stripeCustomerId,
          paymentMethodId,
          amountMinorUnits: authorizationAmount,
          currency: fareConfig.currency,
        })
      : ({ status: 'declined' } as const);

  if (outcome.status === 'declined') {
    await releaseUnauthorizedTrip(firestore, tripSnap, passengerId);
    return 'declined';
  }

  await tripRef.update({
    paymentIntentId: outcome.paymentIntentId,
    paymentStatus: 'authorized',
    estimatedFare,
    authorizedAmountMinorUnits: authorizationAmount,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return 'authorized';
}
