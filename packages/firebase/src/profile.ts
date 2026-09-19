import { validateProfileUpdate, type ProfileUpdateValues } from '@ridemesh/types';
import { updateProfile as updateAuthProfile } from 'firebase/auth';
import { doc, onSnapshot, serverTimestamp, updateDoc } from 'firebase/firestore';
import { AuthFlowError } from './auth-errors';
import type { FirebaseClient } from './client';

export const PROFILE_SAVE_TIMEOUT_MS = 15_000;

export interface ProfileData {
  role: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
}

export type ProfileSnapshot = { status: 'ready'; profile: ProfileData } | { status: 'missing' };

/** Follows users/{uid} live, so a saved change shows up without reloading. */
export function subscribeToProfile(
  client: Pick<FirebaseClient, 'firestore'>,
  uid: string,
  onChange: (snapshot: ProfileSnapshot) => void,
  onError: (error: unknown) => void,
): () => void {
  return onSnapshot(
    doc(client.firestore, 'users', uid),
    (snapshot) => {
      if (!snapshot.exists()) {
        onChange({ status: 'missing' });
        return;
      }
      const data = snapshot.data();
      onChange({
        status: 'ready',
        profile: {
          role: String(data.role ?? ''),
          name: String(data.name ?? ''),
          email: String(data.email ?? ''),
          phone: typeof data.phone === 'string' && data.phone.length > 0 ? data.phone : null,
          status: String(data.status ?? ''),
        },
      });
    },
    onError,
  );
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new AuthFlowError('network', 'Check your internet connection and try again.')),
      milliseconds,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Saves the person's name and phone straight to their own users/{uid} document. The Firestore
 * rules allow exactly this write (and nothing else on that document). Firestore is the source of
 * truth; the Firebase Auth display name is updated afterwards on a best-effort basis so the two do
 * not drift.
 *
 * A write made while offline does not fail on its own, so it is abandoned after a timeout with a
 * "check your connection" error. The person can retry; repeating the same write is harmless.
 */
export async function saveProfile(
  client: Pick<FirebaseClient, 'auth' | 'firestore'>,
  values: ProfileUpdateValues,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const user = client.auth.currentUser;
  if (!user) throw new AuthFlowError('permission', 'You need to sign in again.');

  const validation = validateProfileUpdate(values);
  if (!validation.ok) {
    throw new AuthFlowError('validation', 'Please check the highlighted fields.');
  }
  const { name, phone } = validation.data;

  await withTimeout(
    updateDoc(doc(client.firestore, 'users', user.uid), {
      name,
      phone,
      updatedAt: serverTimestamp(),
    }),
    options.timeoutMs ?? PROFILE_SAVE_TIMEOUT_MS,
  );

  await updateAuthProfile(user, { displayName: name }).catch(() => undefined);
}
