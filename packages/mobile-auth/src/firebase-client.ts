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
 * Creates the Firebase client for a mobile app. On phones the signed-in session is stored in
 * AsyncStorage so people stay signed in after closing the app; on web the browser default is used.
 */
export function createMobileFirebaseClient(
  config: FirebaseWebConfig,
  emulatorHost?: string,
): FirebaseClient {
  const persistence = Platform.OS === 'web' ? undefined : getReactNativePersistence?.(AsyncStorage);
  return createFirebaseClient(config, { emulatorHost, persistence });
}
