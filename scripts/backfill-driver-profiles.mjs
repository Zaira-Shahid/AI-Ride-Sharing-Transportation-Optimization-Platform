#!/usr/bin/env node
// Creates a driver profile (drivers/{uid}) for every driver account that does not have one yet.
// Existing profiles are left untouched, so it is safe to run more than once.
//
//   npm run admin:backfill-driver-profiles -- --confirm-production
//
// Run against the emulators (FIRESTORE_EMULATOR_HOST set) without the flag. Against the real
// project it needs service-account credentials in GOOGLE_APPLICATION_CREDENTIALS and the explicit
// --confirm-production flag.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));

const usingEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
if (!usingEmulator && !flags.has('--confirm-production')) {
  console.error(
    'Refusing to run against the real project without --confirm-production. ' +
      'To test safely, run the Firebase emulators and set FIRESTORE_EMULATOR_HOST.',
  );
  process.exit(1);
}

const firebaserc = JSON.parse(readFileSync(join(root, '.firebaserc'), 'utf8'));
const projectId = process.env.GCLOUD_PROJECT ?? firebaserc.projects.default;

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { backfillDriverProfiles } = require(join(root, 'functions', 'lib', 'drivers.js'));

initializeApp({ projectId });

try {
  const result = await backfillDriverProfiles({ firestore: getFirestore() });
  console.log(
    `Checked ${result.drivers} driver account(s); created ${result.created} driver profile(s).`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
