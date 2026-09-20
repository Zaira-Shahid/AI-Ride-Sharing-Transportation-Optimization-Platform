import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createFirebaseClient,
  type FirebaseClient,
  type FirebaseWebConfig,
} from '@ridemesh/firebase';
import * as firebaseAuth from 'firebase/auth';
import type { Persistence } from 'firebase/auth';
import { Platform } from 'react-native';

type PersistenceFactory = (storage: typeof AsyncStorage) => Persistence;

// The React Native build of firebase/auth exports getReactNativePersistence, but Firebase's type
// definitions resolve to the web entry point and omit it, so it is read through the namespace.
const { getReactNativePersistence } = firebaseAuth as unknown as {
  getReactNativePersistence?: PersistenceFactory;
};

/**
 * Where the web build keeps the signed-in session: IndexedDB, then localStorage. Naming the
 * persistence (rather than calling getAuth) initialises Firebase Auth without its popup and
 * redirect resolver. These apps only sign in with email and password, so they never need it, and
 * on mobile browsers and Safari it makes Auth wait for Google's script (apis.google.com) before it
 * reports the first sign-in state, which left the app on its loading spinner whenever that request
 * was slow (see docs/development.md).
 */
const webPersistence = (): Persistence[] => [
  firebaseAuth.indexedDBLocalPersistence,
  firebaseAuth.browserLocalPersistence,
];

/**
 * Creates the Firebase client for a mobile app. On phones the signed-in session is stored in
 * AsyncStorage so people stay signed in after closing the app; on web it is kept in the browser
 * (see webPersistence). It is a function because the React Native build of firebase/auth has no
 * web persistence to export, so it must only be read on the web.
 */
export function createMobileFirebaseClient(
  config: FirebaseWebConfig,
  emulatorHost?: string,
): FirebaseClient {
  const persistence =
    Platform.OS === 'web' ? webPersistence() : getReactNativePersistence?.(AsyncStorage);
  return createFirebaseClient(config, { emulatorHost, persistence });
}
