import { createMobileFirebaseClient } from '@ridemesh/mobile-auth';
import { readFirebaseConfig } from './firebase-config';

export function getFirebaseClient() {
  return createMobileFirebaseClient(
    readFirebaseConfig(),
    process.env.EXPO_PUBLIC_FIREBASE_EMULATOR_HOST || undefined,
  );
}
