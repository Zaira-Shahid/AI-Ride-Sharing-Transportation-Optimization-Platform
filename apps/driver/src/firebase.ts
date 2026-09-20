import { parsePortOffset } from '@ridemesh/config';
import { createMobileFirebaseClient } from '@ridemesh/mobile-auth';
import { readFirebaseConfig } from './firebase-config';

export function getFirebaseClient() {
  // Expo only inlines variables that are referenced literally.
  return createMobileFirebaseClient(
    readFirebaseConfig(),
    process.env.EXPO_PUBLIC_FIREBASE_EMULATOR_HOST || undefined,
    parsePortOffset(process.env.EXPO_PUBLIC_FIREBASE_EMULATOR_PORT_OFFSET),
  );
}
