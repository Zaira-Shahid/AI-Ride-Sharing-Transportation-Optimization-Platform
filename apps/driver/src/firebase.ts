import {
  createFirebaseClient,
  initializeFirebaseApp,
  parseFirebaseWebConfig,
} from '@ridemesh/firebase';

export function readFirebaseConfig() {
  return parseFirebaseWebConfig({
    apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
    measurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID,
  });
}

export function getFirebaseApp() {
  return initializeFirebaseApp(readFirebaseConfig());
}

export function getFirebaseClient() {
  return createFirebaseClient(readFirebaseConfig(), {
    emulatorHost: process.env.EXPO_PUBLIC_FIREBASE_EMULATOR_HOST || undefined,
  });
}
