import { EMULATOR_PORTS, FIREBASE_REGION } from '@ridemesh/config';
import type { FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  initializeAuth,
  type Auth,
  type Persistence,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore,
  type Firestore,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import { initializeFirebaseApp } from './app';
import { getErrorCode } from './auth-errors';
import type { FirebaseWebConfig } from './config';

export interface FirebaseClient {
  app: FirebaseApp;
  auth: Auth;
  functions: Functions;
  firestore: Firestore;
}

export interface FirebaseClientOptions {
  /** Host running the Firebase emulators. Leave undefined to use the real project. */
  emulatorHost?: string | undefined;
  /**
   * Where the signed-in session is stored, in order of preference. Leave undefined to use the
   * platform default (getAuth), which on the web also loads the popup and redirect sign-in support.
   */
  persistence?: Persistence | Persistence[] | undefined;
}

const clients = new Map<string, FirebaseClient>();

function createAuth(app: FirebaseApp, persistence: Persistence | Persistence[] | undefined): Auth {
  if (!persistence) return getAuth(app);
  try {
    return initializeAuth(app, { persistence });
  } catch (error) {
    // Auth was already initialised for this app (for example after a fast refresh).
    if (getErrorCode(error) === 'auth/already-initialized') return getAuth(app);
    throw error;
  }
}

function createFirestore(app: FirebaseApp): Firestore {
  try {
    // Falls back to long polling where the default streaming transport is unavailable, which
    // happens on some React Native networks.
    return initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  } catch {
    // Already initialised for this app (for example after a fast refresh).
    return getFirestore(app);
  }
}

export function createFirebaseClient(
  config: FirebaseWebConfig,
  options: FirebaseClientOptions = {},
): FirebaseClient {
  const app = initializeFirebaseApp(config);
  const existing = clients.get(app.name);
  if (existing) return existing;

  const auth = createAuth(app, options.persistence);
  const functions = getFunctions(app, FIREBASE_REGION);
  const firestore = createFirestore(app);

  const host = options.emulatorHost?.trim();
  if (host) {
    connectAuthEmulator(auth, `http://${host}:${EMULATOR_PORTS.auth}`, { disableWarnings: true });
    connectFunctionsEmulator(functions, host, EMULATOR_PORTS.functions);
    connectFirestoreEmulator(firestore, host, EMULATOR_PORTS.firestore);
  }

  const client = { app, auth, functions, firestore };
  clients.set(app.name, client);
  return client;
}
