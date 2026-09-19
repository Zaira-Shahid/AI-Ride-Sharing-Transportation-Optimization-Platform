import { EMULATOR_PORTS, FIREBASE_REGION } from '@ridemesh/config';
import type { FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  initializeAuth,
  type Auth,
  type Persistence,
} from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import { initializeFirebaseApp } from './app';
import { getErrorCode } from './auth-errors';
import type { FirebaseWebConfig } from './config';

export interface FirebaseClient {
  app: FirebaseApp;
  auth: Auth;
  functions: Functions;
}

export interface FirebaseClientOptions {
  /** Host running the Firebase emulators. Leave undefined to use the real project. */
  emulatorHost?: string | undefined;
  /** Where the signed-in session is stored. Leave undefined to use the platform default. */
  persistence?: Persistence | undefined;
}

const clients = new Map<string, FirebaseClient>();

function createAuth(app: FirebaseApp, persistence: Persistence | undefined): Auth {
  if (!persistence) return getAuth(app);
  try {
    return initializeAuth(app, { persistence });
  } catch (error) {
    // Auth was already initialised for this app (for example after a fast refresh).
    if (getErrorCode(error) === 'auth/already-initialized') return getAuth(app);
    throw error;
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

  const host = options.emulatorHost?.trim();
  if (host) {
    connectAuthEmulator(auth, `http://${host}:${EMULATOR_PORTS.auth}`, { disableWarnings: true });
    connectFunctionsEmulator(functions, host, EMULATOR_PORTS.functions);
  }

  const client = { app, auth, functions };
  clients.set(app.name, client);
  return client;
}
