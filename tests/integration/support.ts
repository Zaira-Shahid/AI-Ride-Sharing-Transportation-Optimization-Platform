import { getApp, getApps, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  sendEmailVerification,
  type User,
} from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';

// Set by `firebase emulators:exec`; the ports come from firebase.json.
export const projectId = process.env.GCLOUD_PROJECT ?? 'demo-ridemesh';
export const PASSWORD = 'correct-horse-battery-staple';

let counter = 0;

export function createClient() {
  const app = initializeApp({ apiKey: 'emulator-api-key', projectId }, `client-${counter++}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const functions = getFunctions(app, 'europe-west1');
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  return { app, auth, functions, db, firestore: db };
}

export type Client = ReturnType<typeof createClient>;

export function admin() {
  const app = getApps().length > 0 ? getApp() : initializeAdminApp({ projectId });
  return { auth: getAdminAuth(app), firestore: getAdminFirestore(app) };
}

export function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${counter++}@example.test`;
}

export async function signUp(client: Client, prefix: string) {
  const email = uniqueEmail(prefix);
  const credential = await createUserWithEmailAndPassword(client.auth, email, PASSWORD);
  return { email, user: credential.user, uid: credential.user.uid };
}

export async function verifyEmail(user: User, email: string) {
  await sendEmailVerification(user);
  const response = await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${projectId}/oobCodes`);
  const { oobCodes } = (await response.json()) as {
    oobCodes: { email: string; oobCode: string; requestType: string }[];
  };
  const code = oobCodes
    .filter((entry) => entry.email === email && entry.requestType === 'VERIFY_EMAIL')
    .at(-1);
  if (!code) throw new Error(`No verification code was issued for ${email}`);
  const applied = await fetch(
    'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:update?key=emulator-api-key',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oobCode: code.oobCode }),
    },
  );
  if (!applied.ok) throw new Error(`Email verification failed for ${email}`);
  await user.getIdToken(true);
}
