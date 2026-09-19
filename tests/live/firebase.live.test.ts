// Live checks against the real Firebase project. They need the local, git-ignored env files created
// from `.env.example`, and are run explicitly with `npm run verify:firebase`.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deleteApp, getApps } from 'firebase/app';
import { doc, getDoc, getFirestore } from 'firebase/firestore';
import { afterEach, describe, expect, it } from 'vitest';
import { readFirebaseConfig as readAdminConfig } from '../../apps/admin/lib/firebase';
import { readFirebaseConfig as readDriverConfig } from '../../apps/driver/src/firebase';
import { readFirebaseConfig as readPassengerConfig } from '../../apps/passenger/src/firebase';
import { initializeFirebaseApp } from '../../packages/firebase/src';

const root = resolve(__dirname, '../..');
const firebaserc = JSON.parse(readFileSync(join(root, '.firebaserc'), 'utf8')) as {
  projects: { default: string };
};
const expectedProjectId = firebaserc.projects.default;

const envFiles = {
  admin: join(root, 'apps/admin/.env.local'),
  passenger: join(root, 'apps/passenger/.env'),
  driver: join(root, 'apps/driver/.env'),
};

function loadEnv(file: string) {
  for (const key of Object.keys(process.env)) {
    if (key.includes('FIREBASE_')) delete process.env[key];
  }
  process.loadEnvFile(file);
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('environment configuration', () => {
  it.each([
    ['admin', readAdminConfig],
    ['passenger', readPassengerConfig],
    ['driver', readDriverConfig],
  ] as const)('%s reads a complete config for the pinned project', (name, read) => {
    expect(existsSync(envFiles[name]), `${envFiles[name]} is missing`).toBe(true);
    loadEnv(envFiles[name]);
    expect(read().projectId).toBe(expectedProjectId);
  });
});

describe('Firestore connectivity and rules', () => {
  it('reaches the project and is denied by the deny-all rules', async () => {
    loadEnv(envFiles.admin);
    const db = getFirestore(initializeFirebaseApp(readAdminConfig()));
    await expect(getDoc(doc(db, 'connectivityProbe/none'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  }, 30_000);
});
