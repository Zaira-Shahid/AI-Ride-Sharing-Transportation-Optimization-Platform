import type { Firestore } from 'firebase-admin/firestore';
import type { PushProvider } from './pushProvider.js';

// Module 10.1/10.2 foundation: the one generic capability every future notification-type module
// (10.3 onwards) will reuse - look up a user's own saved push token and send to it, doing nothing (not
// an error) if they have none. Mirrors notifications.ts's own createNotification as the shared
// building block for the in-app notifications collection; unlike it, nothing calls this yet -
// user-approved scope for this pass is foundation only, wiring a real event (a trip matched, a
// payment captured, ...) into it is a later module's own job.

export interface PushNotificationContent {
  title: string;
  body: string;
}

/** Never throws - a push failure (no token, an invalid one, Expo's own service erroring) is silent. */
export async function sendPushToUser(
  deps: { firestore: Firestore; push: PushProvider },
  userId: string,
  notification: PushNotificationContent,
): Promise<void> {
  const userSnap = await deps.firestore.collection('users').doc(userId).get();
  const token = userSnap.get('pushToken');
  if (typeof token !== 'string' || !token) return;

  await deps.push.sendPush({ token, ...notification }).catch(() => undefined);
}
