import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const root = resolve(__dirname, '../..');
let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-ridemesh-rules',
    firestore: {
      rules: readFileSync(join(root, 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users/passenger-1'), { role: 'PASSENGER', name: 'Passenger One' });
    await setDoc(doc(db, 'users/driver-1'), { role: 'DRIVER', name: 'Driver One' });
    // A document whose stored role says ADMIN must never grant anything on its own.
    await setDoc(doc(db, 'users/forger-1'), { role: 'ADMIN', name: 'Forger' });
    await setDoc(doc(db, 'auditLogs/log-1'), { action: 'ROLE_ASSIGNED' });
    await setDoc(doc(db, 'tripRequests/trip-1'), { passengerId: 'passenger-1' });
  });
});

const verified = (role: string) => ({ email_verified: true, role });

describe('users: reading', () => {
  it('lets a verified user read their own profile', async () => {
    const db = env.authenticatedContext('passenger-1', verified('PASSENGER')).firestore();
    await assertSucceeds(getDoc(doc(db, 'users/passenger-1')));
  });

  it('denies a user whose email is not verified, even for their own profile', async () => {
    const db = env
      .authenticatedContext('passenger-1', { email_verified: false, role: 'PASSENGER' })
      .firestore();
    await assertFails(getDoc(doc(db, 'users/passenger-1')));
  });

  it('denies unauthenticated reads', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'users/passenger-1')));
  });

  it.each(['PASSENGER', 'DRIVER'])('denies a %s reading another user profile', async (role) => {
    const db = env.authenticatedContext('driver-1', verified(role)).firestore();
    await assertFails(getDoc(doc(db, 'users/passenger-1')));
  });

  it.each(['SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN'])(
    'lets a verified %s read any user profile',
    async (role) => {
      const db = env.authenticatedContext('staff-1', verified(role)).firestore();
      await assertSucceeds(getDoc(doc(db, 'users/passenger-1')));
    },
  );

  it('denies a staff member whose email is not verified', async () => {
    const db = env
      .authenticatedContext('staff-1', { email_verified: false, role: 'ADMIN' })
      .firestore();
    await assertFails(getDoc(doc(db, 'users/passenger-1')));
  });

  it('ignores the role stored in a profile document', async () => {
    const db = env.authenticatedContext('forger-1', verified('PASSENGER')).firestore();
    await assertFails(getDoc(doc(db, 'users/passenger-1')));
  });

  it.each(['admin', 'ROOT', ''])('does not treat the claim "%s" as staff', async (role) => {
    const db = env.authenticatedContext('someone', verified(role)).firestore();
    await assertFails(getDoc(doc(db, 'users/passenger-1')));
  });

  it('denies a user with no role claim reading another profile', async () => {
    const db = env.authenticatedContext('someone', { email_verified: true }).firestore();
    await assertFails(getDoc(doc(db, 'users/passenger-1')));
  });
});

describe('users: writing', () => {
  it.each(['PASSENGER', 'DRIVER', 'SUPPORT', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN'])(
    'denies every client write, including from a %s',
    async (role) => {
      const db = env.authenticatedContext('passenger-1', verified(role)).firestore();
      await assertFails(updateDoc(doc(db, 'users/passenger-1'), { name: 'Changed' }));
      await assertFails(updateDoc(doc(db, 'users/passenger-1'), { role: 'ADMIN' }));
      await assertFails(setDoc(doc(db, 'users/new-user'), { role: 'ADMIN', name: 'Nope' }));
      await assertFails(deleteDoc(doc(db, 'users/passenger-1')));
    },
  );
});

describe('other collections stay closed', () => {
  it.each(['auditLogs/log-1', 'tripRequests/trip-1', 'payments/pay-1'])(
    'denies %s to every role',
    async (path) => {
      for (const role of ['PASSENGER', 'DRIVER', 'ADMIN', 'SUPER_ADMIN']) {
        const db = env.authenticatedContext('passenger-1', verified(role)).firestore();
        await assertFails(getDoc(doc(db, path)));
        await assertFails(setDoc(doc(db, path), { any: 'thing' }));
      }
    },
  );
});
