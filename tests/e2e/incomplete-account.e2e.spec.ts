import { expect, test } from '@playwright/test';
import {
  PASSWORD,
  apps,
  createAccount,
  openLogin,
  readProfileDoc,
  submitLogin,
  uniqueEmail,
} from './helpers';

const notice = 'Your email is verified, but your account setup was not finished.';

// A verified account with no role (created outside the app, for instance in the Emulator UI, or a
// registration that stopped half-way) used to stay on the Login screen with no message.
for (const app of apps) {
  test.describe(`${app.name} app: account without a role`, () => {
    test('sign-in leads to finishing the set-up, which completes the account', async ({ page }) => {
      const email = uniqueEmail(`incomplete-${app.name}`);
      const uid = await createAccount(email, null, true);

      await openLogin(page, app.url, app.title);
      await submitLogin(page, email, PASSWORD);

      await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
      await expect(page.getByText(notice)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0);

      // Finishing with the same email and password completes the account and reaches the app.
      await page.getByLabel('Full name').fill('Grace Hopper');
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
      await page.getByLabel('Confirm password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page.getByText(app.home)).toBeVisible();
      expect(await readProfileDoc(uid)).toMatchObject({ name: 'Grace Hopper', role: app.role });
    });

    test('a reload keeps the person on the set-up, and they can leave with another account', async ({
      page,
    }) => {
      const email = uniqueEmail(`incomplete-reload-${app.name}`);
      const other = uniqueEmail(`complete-${app.name}`);
      await createAccount(email, null, true);
      await createAccount(other, app.role, true);

      await openLogin(page, app.url, app.title);
      await submitLogin(page, email, PASSWORD);
      await expect(page.getByText(notice)).toBeVisible();

      await page.reload();
      await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
      await expect(page.getByText(notice)).toBeVisible();

      // There is no way to Login while signed in without a role, so the way out is explicit.
      await expect(
        page.getByRole('button', { name: 'Already have an account? Sign in' }),
      ).toHaveCount(0);
      await page.getByRole('button', { name: 'Use a different account' }).click();
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

      await submitLogin(page, other, PASSWORD);
      await expect(page.getByText(app.home)).toBeVisible();
    });

    test('a normal registration form still offers the sign-in link', async ({ page }) => {
      await page.goto(app.url);
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(
        page.getByRole('button', { name: 'Already have an account? Sign in' }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Use a different account' })).toHaveCount(0);
    });
  });
}
