import { expect, test } from '@playwright/test';
import { PASSWORD, apps, createAccount, openLogin, submitLogin, uniqueEmail } from './helpers';

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
