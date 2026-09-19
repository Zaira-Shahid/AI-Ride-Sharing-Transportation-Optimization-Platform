#!/usr/bin/env node
// Assigns a staff role (SUPPORT, OPERATIONS, ADMIN, SUPER_ADMIN) to an existing account.
//
//   npm run admin:set-staff-role -- <email> <ROLE> --confirm-production
//
// Run against the emulators (FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST set) without
// the flag. Against the real project it needs service-account credentials in
// GOOGLE_APPLICATION_CREDENTIALS and the explicit --confirm-production flag. Roles can never be
// assigned from an app.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const [email, role] = args.filter((arg) => !arg.startsWith('--'));

if (!email || !role) {
  console.error('Usage: npm run admin:set-staff-role -- <email> <ROLE> [--confirm-production]');
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
const { assignStaffRole } = require(join(root, 'functions', 'lib', 'staff.js'));

initializeApp({ projectId });

try {
  const result = await assignStaffRole({ auth: getAuth(), firestore: getFirestore() }, email, role);
  console.log(
    `Assigned ${result.role} to ${email} (previous role: ${result.previousRole ?? 'none'}).`,
  );
  if (!result.emailVerified) {
    console.warn('Warning: this email address is not verified yet, so access rules will deny it.');
  }
  console.log('The person must sign in again for the new role to take effect.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
