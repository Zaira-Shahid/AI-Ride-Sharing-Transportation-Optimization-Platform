import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { getIdTokenResult, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { describe, expect, it } from 'vitest';
import { PASSWORD, admin, createClient, signUp, verifyEmail, type Client } from './support';

const root = resolve(__dirname, '../..');

function completeRegistration(client: Client, data: unknown) {
  return httpsCallable(client.functions, 'completeRegistration')(data);
}

function runScript(args: string[], env: NodeJS.ProcessEnv = process.env) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(root, 'scripts/set-staff-role.mjs'), ...args],
      {
        env,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status: number; stderr: string; stdout: string };
    return { status: failure.status, output: `${failure.stdout}${failure.stderr}` };
  }
}

describe('completeRegistration (functions + auth + firestore emulators)', () => {
  it('rejects unauthenticated callers', async () => {
    const client = createClient();
    await expect(
      completeRegistration(client, { role: 'PASSENGER', name: 'Ada' }),
    ).rejects.toMatchObject({ code: 'functions/unauthenticated' });
  });

  it('assigns the passenger role as a server-set claim and creates the profile', async () => {
    const client = createClient();
    const { user, uid, email } = await signUp(client, 'passenger');

    const result = await completeRegistration(client, {
      role: 'PASSENGER',
      name: '  Ada Lovelace ',
      phone: '+441234567890',
    });
    expect(result.data).toEqual({ role: 'PASSENGER' });

    const { auth, firestore } = admin();
    expect((await auth.getUser(uid)).customClaims).toEqual({ role: 'PASSENGER' });

    const profile = (await firestore.doc(`users/${uid}`).get()).data();
    expect(profile).toMatchObject({
      role: 'PASSENGER',
      name: 'Ada Lovelace',
      email,
      phone: '+441234567890',
      photoUrl: null,
      status: 'ACTIVE',
    });
    expect(profile?.createdAt).toBeDefined();

    const token = await getIdTokenResult(user, true);
    expect(token.claims.role).toBe('PASSENGER');
  });

  it('assigns the driver role and stores no phone when none is given', async () => {
    const client = createClient();
    const { uid } = await signUp(client, 'driver');
    await completeRegistration(client, { role: 'DRIVER', name: 'Dan' });

    const { auth, firestore } = admin();
    expect((await auth.getUser(uid)).customClaims).toEqual({ role: 'DRIVER' });
    expect((await firestore.doc(`users/${uid}`).get()).get('phone')).toBeNull();
  });

  it.each(['ADMIN', 'SUPER_ADMIN', 'OPERATIONS', 'SUPPORT'])(
    'refuses to let a client request the %s role',
    async (role) => {
      const client = createClient();
      const { uid } = await signUp(client, 'escalate');
      await expect(completeRegistration(client, { role, name: 'Mallory' })).rejects.toMatchObject({
        code: 'functions/invalid-argument',
      });

      const { auth, firestore } = admin();
      expect((await auth.getUser(uid)).customClaims ?? {}).toEqual({});
      expect((await firestore.doc(`users/${uid}`).get()).exists).toBe(false);
    },
  );

  it('never lets an assigned role be changed through the app', async () => {
    const client = createClient();
    const { uid } = await signUp(client, 'switch');
    await completeRegistration(client, { role: 'DRIVER', name: 'Dan' });

    await expect(
      completeRegistration(client, { role: 'PASSENGER', name: 'Dan' }),
    ).rejects.toMatchObject({ code: 'functions/failed-precondition' });
    expect((await admin().auth.getUser(uid)).customClaims).toEqual({ role: 'DRIVER' });
  });

  it('is safe to call again with the same role and records a single audit entry', async () => {
    const client = createClient();
    const { uid } = await signUp(client, 'retry');
    await completeRegistration(client, { role: 'PASSENGER', name: 'Ada' });
    await completeRegistration(client, { role: 'PASSENGER', name: 'Ada' });

    const audit = await admin()
      .firestore.collection('auditLogs')
      .where('entity', '==', `users/${uid}`)
      .get();
    expect(audit.size).toBe(1);
    expect(audit.docs[0]?.data()).toMatchObject({
      actor: uid,
      action: 'ROLE_ASSIGNED',
      previousState: null,
      newState: { role: 'PASSENGER' },
    });
  });

  it('rejects invalid details', async () => {
    const client = createClient();
    await signUp(client, 'invalid');
    await expect(
      completeRegistration(client, { role: 'PASSENGER', name: '   ' }),
    ).rejects.toMatchObject({ code: 'functions/invalid-argument' });
    await expect(completeRegistration(client, {})).rejects.toMatchObject({
      code: 'functions/invalid-argument',
    });
  });
});

describe('access after registration (rules enforced through real auth tokens)', () => {
  it('requires a verified email before anything can be read', async () => {
    const client = createClient();
    const { user, uid, email } = await signUp(client, 'verify');
    await completeRegistration(client, { role: 'PASSENGER', name: 'Ada' });
    await user.getIdToken(true);

    await expect(getDoc(doc(client.db, `users/${uid}`))).rejects.toMatchObject({
      code: 'permission-denied',
    });

    await verifyEmail(user, email);
    const snapshot = await getDoc(doc(client.db, `users/${uid}`));
    expect(snapshot.get('role')).toBe('PASSENGER');
  });

  it('keeps users apart and blocks every client write to profiles', async () => {
    const first = createClient();
    const a = await signUp(first, 'a');
    await completeRegistration(first, { role: 'PASSENGER', name: 'A' });
    await verifyEmail(a.user, a.email);

    const second = createClient();
    const b = await signUp(second, 'b');
    await completeRegistration(second, { role: 'DRIVER', name: 'B' });
    await verifyEmail(b.user, b.email);

    await expect(getDoc(doc(first.db, `users/${b.uid}`))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(getDoc(doc(second.db, `users/${a.uid}`))).rejects.toMatchObject({
      code: 'permission-denied',
    });

    await expect(
      updateDoc(doc(first.db, `users/${a.uid}`), { role: 'ADMIN' }),
    ).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(
      setDoc(doc(first.db, `users/${a.uid}`), { role: 'ADMIN', name: 'A' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await admin().firestore.doc(`users/${a.uid}`).get()).get('role')).toBe('PASSENGER');
  });
});

describe('staff roles (service-account script)', () => {
  it('assigns a staff role that then grants read access, and audits it', async () => {
    const staffClient = createClient();
    const staff = await signUp(staffClient, 'staff');
    await verifyEmail(staff.user, staff.email);

    const targetClient = createClient();
    const target = await signUp(targetClient, 'target');
    await completeRegistration(targetClient, { role: 'PASSENGER', name: 'Target' });

    const run = runScript([staff.email, 'ADMIN']);
    expect(run.output).toContain('Assigned ADMIN');
    expect(run.status).toBe(0);

    const { auth, firestore } = admin();
    expect((await auth.getUser(staff.uid)).customClaims).toEqual({ role: 'ADMIN' });
    expect((await firestore.doc(`users/${staff.uid}`).get()).get('role')).toBe('ADMIN');

    const audit = await firestore
      .collection('auditLogs')
      .where('entity', '==', `users/${staff.uid}`)
      .get();
    expect(audit.docs[0]?.data()).toMatchObject({
      actor: 'script:set-staff-role',
      newState: { role: 'ADMIN' },
    });

    // The old session was revoked, so the person signs in again to receive the new claim.
    await signOut(staffClient.auth);
    const fresh = await signInWithEmailAndPassword(staffClient.auth, staff.email, PASSWORD);
    expect((await getIdTokenResult(fresh.user, true)).claims.role).toBe('ADMIN');

    const profile = await getDoc(doc(staffClient.db, `users/${target.uid}`));
    expect(profile.get('name')).toBe('Target');

    await expect(getDoc(doc(targetClient.db, `users/${staff.uid}`))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('promotes an existing passenger account and replaces the role', async () => {
    const client = createClient();
    const person = await signUp(client, 'promote');
    await completeRegistration(client, { role: 'PASSENGER', name: 'Pat' });

    expect(runScript([person.email, 'SUPPORT']).status).toBe(0);
    expect((await admin().auth.getUser(person.uid)).customClaims).toEqual({ role: 'SUPPORT' });
  });

  it.each(['PASSENGER', 'DRIVER', 'ROOT'])('refuses to assign the non-staff role %s', (role) => {
    const run = runScript(['someone@example.test', role]);
    expect(run.status).toBe(1);
    expect(run.output).toContain('Role must be one of');
  });

  it('refuses to run against the real project without explicit confirmation', () => {
    const env = { ...process.env };
    delete env.FIREBASE_AUTH_EMULATOR_HOST;
    delete env.FIRESTORE_EMULATOR_HOST;
    const run = runScript(['someone@example.test', 'ADMIN'], env);
    expect(run.status).toBe(1);
    expect(run.output).toContain('--confirm-production');
  });
});
