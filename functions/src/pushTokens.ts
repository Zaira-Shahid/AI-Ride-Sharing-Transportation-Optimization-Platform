import { Expo } from 'expo-server-sdk';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { requireVerifiedRider, type Caller } from './callers.js';

// Module 10.2 (push tokens): a passenger or driver's own Expo push token (Module 10.1's own chosen
// mechanism), kept on their own users/{uid} doc. Only ever the most recent token is kept - one device,
// the same "only ever the most recent one" stance paymentMethods.ts's own savePaymentMethod already
// takes; multi-device support is a later module's own decision, not this one's.

export const savePushTokenInputSchema = z.object({ token: z.string().min(1).max(200) });
export type SavePushTokenInput = z.infer<typeof savePushTokenInputSchema>;
export interface SavePushTokenResult {
  status: 'saved';
}

/**
 * Saves the calling passenger's or driver's own Expo push token, replacing any previous one. Rejects
 * anything that is not shaped like a real Expo push token (Expo.isExpoPushToken - a format check
 * only, no network call) - a mistaken raw device token or a typo is caught here, not silently stored.
 */
export async function savePushToken(
  deps: { firestore: Firestore },
  caller: Caller,
  rawInput: unknown,
): Promise<SavePushTokenResult> {
  requireVerifiedRider(caller);

  const parsed = savePushTokenInputSchema.safeParse(rawInput);
  if (!parsed.success || !Expo.isExpoPushToken(parsed.data.token)) {
    throw new HttpsError('invalid-argument', 'That push token is not valid.');
  }

  await deps.firestore.collection('users').doc(caller.uid).update({
    pushToken: parsed.data.token,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { status: 'saved' };
}
