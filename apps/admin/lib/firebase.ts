import { createFirebaseClient, parseFirebaseWebConfig } from '@ridemesh/firebase';
import { parsePortOffset } from '@ridemesh/config';

export function readFirebaseConfig() {
  return parseFirebaseWebConfig({
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
  });
}

/**
 * Module 11.1 (admin dashboard foundation): the admin console's own auth+functions+firestore client -
 * createFirebaseClient itself is platform-agnostic (the web Firebase SDK), unlike
 * @ridemesh/mobile-auth's own createMobileFirebaseClient (Expo-specific persistence), so it is used
 * directly here rather than through that package. No persistence option is passed, so it falls back to
 * the web SDK's own default (which also loads popup/redirect sign-in support, unneeded here but
 * harmless).
 */
export function getFirebaseClient() {
  return createFirebaseClient(readFirebaseConfig(), {
    emulatorHost: process.env.NEXT_PUBLIC_FIREBASE_EMULATOR_HOST || undefined,
    emulatorPortOffset: parsePortOffset(process.env.NEXT_PUBLIC_FIREBASE_EMULATOR_PORT_OFFSET),
  });
}
