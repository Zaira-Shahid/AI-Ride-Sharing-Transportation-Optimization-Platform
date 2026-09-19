#!/usr/bin/env node
// Verifies or rejects a driver, or a driver's vehicle, by the driver's email address.
//
//   npm run admin:review -- <driver|vehicle> <email> VERIFIED [--confirm-production]
//   npm run admin:review -- <driver|vehicle> <email> REJECTED "Reason shown to the driver" [--confirm-production]
//
// A rejection needs a reason (up to 500 characters); the driver sees it in the app. Run against
// the emulators (FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST set) without the flag.
// Against the real project it needs service-account credentials in GOOGLE_APPLICATION_CREDENTIALS
// and the explicit --confirm-production flag. The same decision is what ADMIN and SUPER_ADMIN staff
// make through the reviewDriver and reviewVehicle functions.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const [what, email, decision, ...reasonWords] = args.filter((arg) => !arg.startsWith('--'));
const reason = reasonWords.join(' ').trim();

const target = { driver: 'DRIVER', vehicle: 'VEHICLE' }[what ?? ''];
if (!target || !email || !decision) {
  console.error(
    'Usage: npm run admin:review -- <driver|vehicle> <email> <VERIFIED|REJECTED> [reason] [--confirm-production]',
  );
  process.exit(1);
}

const usingEmulator = Boolean(
  process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST,
);
if (!usingEmulator && !flags.has('--confirm-production')) {
  console.error(
    'Refusing to run against the real project without --confirm-production. ' +
      'To test safely, run the Firebase emulators and set the emulator host variables.',
  );
  process.exit(1);
}

const firebaserc = JSON.parse(readFileSync(join(root, '.firebaserc'), 'utf8'));
const projectId = process.env.GCLOUD_PROJECT ?? firebaserc.projects.default;

const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { reviewVerification } = require(join(root, 'functions', 'lib', 'verification.js'));

initializeApp({ projectId });

try {
  const user = await getAuth().getUserByEmail(email);
  const result = await reviewVerification(
    { firestore: getFirestore() },
    target,
    'script:review-driver',
    { driverId: user.uid, decision, ...(reason ? { reason } : {}) },
  );
  console.log(
    result.status === 'reviewed'
      ? `Set the ${what} of ${email} to ${decision}.`
      : `The ${what} of ${email} was already ${decision}; nothing changed.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
