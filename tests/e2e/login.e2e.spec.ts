import { expect, test, type Page } from '@playwright/test';

const projectId = 'demo-ridemesh';
const authEmulator = 'http://127.0.0.1:9099';
const key = 'e2e-api-key';
const PASSWORD = 'correct-horse-battery';

const apps = [
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
const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${counter++}@example.test`;

/** Creates an account directly in the Auth emulator, with a server-style role claim. */
async function createAccount(email: string, role: string, verified: boolean) {
  const signUp = await fetch(
    `${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${key}`,
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
      }),
    },
  );
  expect(update.ok).toBe(true);
}

async function openLogin(page: Page, url: string, title: string) {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
}

async function submitLogin(page: Page, email: string, password: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

for (const app of apps) {
  test.describe(`${app.name} app sign-in`, () => {
    test('signs in and stays signed in after a reload', async ({ page }) => {
      const email = uniqueEmail(`login-${app.name}`);
      await createAccount(email, app.role, true);

      await openLogin(page, app.url, app.title);
      await submitLogin(page, email, PASSWORD);
      await expect(page.getByText(app.home)).toBeVisible();

      await page.reload();
      await expect(page.getByText(app.home)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0);
    });

    test('shows the same clear message for a wrong password and an unknown email', async ({
      page,
    }) => {
      const email = uniqueEmail(`wrong-${app.name}`);
      await createAccount(email, app.role, true);
      await openLogin(page, app.url, app.title);

      await submitLogin(page, email, 'definitely-wrong');
      await expect(page.getByText('Incorrect email or password.')).toBeVisible();

      await submitLogin(page, uniqueEmail('nobody'), 'definitely-wrong');
      await expect(page.getByText('Incorrect email or password.')).toBeVisible();
      await expect(page.getByText(app.home)).toHaveCount(0);
    });

    test('refuses an account that belongs to the other app and stays signed out', async ({
      page,
    }) => {
      const email = uniqueEmail(`cross-${app.name}`);
      await createAccount(email, app.otherRole, true);

      await openLogin(page, app.url, app.title);
      await submitLogin(page, email, PASSWORD);
      await expect(page.getByText(app.mismatch)).toBeVisible();
      await expect(page.getByText(app.home)).toHaveCount(0);

      // The refused account was signed out again, so a reload still shows the sign-in form.
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
      await expect(page.getByText(app.home)).toHaveCount(0);
    });

    test('sends an unverified account to email verification', async ({ page }) => {
      const email = uniqueEmail(`unverified-${app.name}`);
      await createAccount(email, app.role, false);

      await openLogin(page, app.url, app.title);
      await submitLogin(page, email, PASSWORD);
      await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
      await expect(page.getByText(app.home)).toHaveCount(0);
    });

    test('validates the form and can switch to registration and back', async ({ page }) => {
      await openLogin(page, app.url, app.title);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByText('Enter a valid email address.')).toBeVisible();
      await expect(page.getByText('Enter your password.')).toBeVisible();

      await page.getByRole('button', { name: /Create account/ }).click();
      await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
      await page.getByRole('button', { name: 'Already have an account? Sign in' }).click();
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    });
  });
}
