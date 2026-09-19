import { expect, test, type Page } from '@playwright/test';

const projectId = 'demo-ridemesh';
const authEmulator = 'http://127.0.0.1:9099';
const PASSWORD = 'correct-horse-battery';

const apps = [
  {
    name: 'passenger',
    url: 'http://localhost:8081',
    title: 'RideMesh',
    role: 'PASSENGER',
    home: 'No active trip',
  },
  {
    name: 'driver',
    url: 'http://localhost:8082',
    title: 'RideMesh Driver',
    role: 'DRIVER',
    home: 'You are offline',
  },
] as const;

let counter = 0;
const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${counter++}@example.test`;

async function verifyEmailViaEmulator(email: string) {
  const response = await fetch(`${authEmulator}/emulator/v1/projects/${projectId}/oobCodes`);
  const { oobCodes } = (await response.json()) as {
    oobCodes: { email: string; oobCode: string; requestType: string }[];
  };
  const code = oobCodes
    .filter((entry) => entry.email === email && entry.requestType === 'VERIFY_EMAIL')
    .at(-1);
  expect(code, `verification email for ${email}`).toBeDefined();
  const applied = await fetch(
    `${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:update?key=e2e-api-key`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oobCode: code?.oobCode }),
    },
  );
  expect(applied.ok).toBe(true);
}

async function claimsFor(email: string) {
  const response = await fetch(
    `${authEmulator}/identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:lookup`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({ email: [email] }),
    },
  );
  const { users } = (await response.json()) as { users?: { customAttributes?: string }[] };
  return JSON.parse(users?.[0]?.customAttributes ?? '{}') as Record<string, unknown>;
}

async function openRegistration(page: Page, url: string, title: string) {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
}

async function fillForm(
  page: Page,
  values: { name: string; email: string; password: string; confirm?: string; phone?: string },
) {
  await page.getByLabel('Full name').fill(values.name);
  await page.getByLabel('Email', { exact: true }).fill(values.email);
  if (values.phone) await page.getByLabel('Phone number (optional)').fill(values.phone);
  await page.getByLabel('Password', { exact: true }).fill(values.password);
  await page.getByLabel('Confirm password').fill(values.confirm ?? values.password);
}

for (const app of apps) {
  test.describe(`${app.name} app registration`, () => {
    test('validates the form, registers, verifies the email and reaches the app', async ({
      page,
    }) => {
      const email = uniqueEmail(`e2e-${app.name}`);
      await openRegistration(page, app.url, app.title);
      const submit = page.getByRole('button', { name: 'Create account' });

      // Empty form: every required field reports a problem and nothing is sent.
      await submit.click();
      await expect(page.getByText('Enter your full name.')).toBeVisible();
      await expect(page.getByText('Enter a valid email address.')).toBeVisible();
      await expect(page.getByText('Use at least 8 characters.')).toBeVisible();

      // A 7-character password and a mismatched confirmation are rejected.
      await fillForm(page, {
        name: 'Ada Lovelace',
        email,
        password: 'short-7',
        confirm: 'different',
      });
      await submit.click();
      await expect(page.getByText('Use at least 8 characters.')).toBeVisible();
      await expect(page.getByText('The passwords do not match.')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Verify your email' })).toHaveCount(0);

      // A valid form creates the account and asks for email verification.
      await fillForm(page, {
        name: 'Ada Lovelace',
        email,
        password: PASSWORD,
        phone: '+44 7700 900123',
      });
      await submit.click();
      await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
      await expect(page.getByText(email)).toBeVisible();
      await expect.poll(() => claimsFor(email)).toEqual({ role: app.role });

      // Before verifying, the app must not let the person in.
      await page.getByRole('button', { name: 'I have verified my email' }).click();
      await expect(page.getByText('We have not seen your verification yet.')).toBeVisible();
      await expect(page.getByText(app.home)).toHaveCount(0);

      // After verifying, the same button lets them in.
      await verifyEmailViaEmulator(email);
      await page.getByRole('button', { name: 'I have verified my email' }).click();
      await expect(page.getByText(app.home)).toBeVisible();
    });

    test('reports an email address that is already registered', async ({ page }) => {
      const email = uniqueEmail(`e2e-taken-${app.name}`);
      await fetch(
        `${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=e2e-api-key`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'someone-elses-password' }),
        },
      );

      await openRegistration(page, app.url, app.title);
      await fillForm(page, { name: 'Mallory', email, password: PASSWORD });
      await page.getByRole('button', { name: 'Create account' }).click();

      await expect(
        page.getByText('An account with this email address already exists.'),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Verify your email' })).toHaveCount(0);
      expect(await claimsFor(email)).toEqual({});
    });

    test('lets the person back out of verification and use a different account', async ({
      page,
    }) => {
      const email = uniqueEmail(`e2e-switch-${app.name}`);
      await openRegistration(page, app.url, app.title);
      await fillForm(page, { name: 'Ada', email, password: PASSWORD });
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();

      await page.getByRole('button', { name: 'Use a different account' }).click();
      await expect(page.getByRole('heading', { name: app.title })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
    });
  });
}
