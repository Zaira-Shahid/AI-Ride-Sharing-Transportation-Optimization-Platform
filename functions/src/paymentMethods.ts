import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { requireVerifiedPassenger, type PassengerCaller } from './callers.js';
import type { StripeProvider } from './stripeProvider.js';

// Module 9.2 (payment authorization): the one prerequisite the spec's own module list does not name
// separately - a passenger needs a saved payment method before any authorization can happen. Backend
// only (user-approved, same as the rest of 9.2): `paymentMethodId` is expected to already exist on
// Stripe, created client-side via Stripe.js/Elements once a real card-entry screen exists (a later
// module's own UI, not this one) - this callable only ever stores Stripe's own reference ids, never a
// card number (spec's own "never store raw card details in Firestore").

export const savePaymentMethodInputSchema = z.object({
  paymentMethodId: z.string().min(1).max(200),
});

export type SavePaymentMethodResult = { status: 'saved' };

/**
 * Saves a Stripe payment method reference for the calling passenger, creating their Stripe Customer
 * first if this is their first one. Replaces any previously saved method (only ever the most recent one
 * is kept - a "manage multiple cards" screen is a later module's own decision, not this one's).
 */
export async function savePaymentMethod(
  deps: { firestore: Firestore; stripe: StripeProvider },
  caller: PassengerCaller,
  rawInput: unknown,
): Promise<SavePaymentMethodResult> {
  requireVerifiedPassenger(caller);

  const parsed = savePaymentMethodInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The payment method is not valid.');
  }

  const { firestore } = deps;
  const userRef = firestore.collection('users').doc(caller.uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists || userSnap.get('status') !== 'ACTIVE') {
    throw new HttpsError('failed-precondition', 'This account cannot save a payment method.');
  }

  const existingCustomerId = userSnap.get('stripeCustomerId');
  const stripeCustomerId =
    typeof existingCustomerId === 'string' && existingCustomerId
      ? existingCustomerId
      : await deps.stripe.createCustomer({
          email: userSnap.get('email'),
          name: userSnap.get('name'),
        });

  await userRef.update({
    stripeCustomerId,
    paymentMethodId: parsed.data.paymentMethodId,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { status: 'saved' };
}
