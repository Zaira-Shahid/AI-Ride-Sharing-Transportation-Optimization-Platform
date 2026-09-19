import { expect, type Page } from '@playwright/test';

export const projectId = 'demo-ridemesh';
export const authEmulator = 'http://127.0.0.1:9099';
export const apiKey = 'e2e-api-key';
export const PASSWORD = 'correct-horse-battery';

export const apps = [
  {
    name: 'passenger',
    url: 'http://localhost:8081',
    title: 'RideMesh',
    role: 'PASSENGER',
    home: 'No active trip',
    otherRole: 'DRIVER',
    mismatch: 'This is a driver account. Please sign in with the RideMesh Driver app.',
  },
  {
    name: 'driver',
    url: 'http://localhost:8082',
    title: 'RideMesh Driver',
    role: 'DRIVER',
    home: 'You are offline',
    otherRole: 'PASSENGER',
    mismatch: 'This is a passenger account. Please sign in with the RideMesh app.',
  },
] as const;

let counter = 0;
export const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${counter++}@example.test`;

/** Creates an account directly in the Auth emulator, with a server-style role claim. */
export async function createAccount(
  email: string,
  role: string,
  verified: boolean,
  displayName?: string,
  profile?: { name: string; phone: string | null },
) {
  const signUp = await fetch(
    `${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    },
  );
  const { localId } = (await signUp.json()) as { localId: string };
  const update = await fetch(
    `${authEmulator}/identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:update`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({
        localId,
        emailVerified: verified,
        customAttributes: JSON.stringify({ role }),
        ...(displayName ? { displayName } : {}),
      }),
    },
  );
  expect(update.ok).toBe(true);
  if (profile) await createProfileDoc(localId, { role, email, ...profile });
  return localId;
}

const firestoreDocs = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;

/** Writes users/{uid} the way the server does, bypassing rules with the emulator owner token. */
async function createProfileDoc(
  uid: string,
  profile: { role: string; email: string; name: string; phone: string | null },
) {
  const now = new Date().toISOString();
  const response = await fetch(`${firestoreDocs}/users?documentId=${uid}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({
      fields: {
        role: { stringValue: profile.role },
        name: { stringValue: profile.name },
        email: { stringValue: profile.email },
        phone: profile.phone ? { stringValue: profile.phone } : { nullValue: null },
        photoUrl: { nullValue: null },
        status: { stringValue: 'ACTIVE' },
        createdAt: { timestampValue: now },
        updatedAt: { timestampValue: now },
      },
    }),
  });
  expect(response.ok).toBe(true);
}

/** What is stored in users/{uid}, read with the emulator owner token. */
export async function readProfileDoc(uid: string) {
  const response = await fetch(`${firestoreDocs}/users/${uid}`, {
    headers: { authorization: 'Bearer owner' },
  });
  const { fields } = (await response.json()) as {
    fields: Record<string, { stringValue?: string; nullValue?: null }>;
  };
  return {
    name: fields.name?.stringValue,
    phone: fields.phone?.stringValue ?? null,
    role: fields.role?.stringValue,
  };
}

export async function openLogin(page: Page, url: string, title: string) {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
}

export async function submitLogin(page: Page, email: string, password: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** The most recent password reset code the Auth emulator issued for an address, if any. */
export async function resetCodeFor(email: string) {
  const response = await fetch(`${authEmulator}/emulator/v1/projects/${projectId}/oobCodes`);
  const { oobCodes } = (await response.json()) as {
    oobCodes: { email: string; oobCode: string; requestType: string }[];
  };
  return oobCodes
    .filter((entry) => entry.email === email && entry.requestType === 'PASSWORD_RESET')
    .at(-1)?.oobCode;
}

/** What Firebase's hosted page does when a person picks a new password. */
export async function chooseNewPassword(oobCode: string, newPassword: string) {
  const response = await fetch(
    `${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oobCode, newPassword }),
    },
  );
  expect(response.ok).toBe(true);
}
