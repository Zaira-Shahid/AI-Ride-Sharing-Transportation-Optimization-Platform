import { EMULATOR_PORTS, FIREBASE_REGION } from '@ridemesh/config';
import type { FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import { initializeFirebaseApp } from './app';
import type { FirebaseWebConfig } from './config';

export interface FirebaseClient {
  app: FirebaseApp;
  auth: Auth;
  functions: Functions;
}

export interface FirebaseClientOptions {
  /** Host running the Firebase emulators. Leave undefined to use the real project. */
  emulatorHost?: string | undefined;
}

const clients = new Map<string, FirebaseClient>();

export function createFirebaseClient(
  config: FirebaseWebConfig,
  options: FirebaseClientOptions = {},
): FirebaseClient {
  const app = initializeFirebaseApp(config);
  const existing = clients.get(app.name);
  if (existing) return existing;

  const auth = getAuth(app);
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
