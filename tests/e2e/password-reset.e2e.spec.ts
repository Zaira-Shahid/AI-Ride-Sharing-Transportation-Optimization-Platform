import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  apps,
  chooseNewPassword,
  createAccount,
  openLogin,
  resetCodeFor,
  submitLogin,
  uniqueEmail,
} from './helpers';

const NEW_PASSWORD = 'a-brand-new-password';

// The sign-in screen stays mounted underneath, so only look at the field that is on screen.
const visibleEmail = (page: Page) =>
  page.getByLabel('Email', { exact: true }).filter({ visible: true });

async function openForgotPassword(page: Page, url: string, title: string) {
  await openLogin(page, url, title);
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
}

for (const app of apps) {
  test.describe(`${app.name} app password reset`, () => {
    test('resets a password from the sign-in screen and signs in with the new one', async ({
      page,
    }) => {
      const email = uniqueEmail(`reset-${app.name}`);
      await createAccount(email, app.role, true);

      await openForgotPassword(page, app.url, app.title);

      // Empty submit is rejected on the screen.
      await page.getByRole('button', { name: 'Send reset link' }).click();
      await expect(page.getByText('Enter a valid email address.')).toBeVisible();

      await visibleEmail(page).fill(email);
      await page.getByRole('button', { name: 'Send reset link' }).click();

      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
      await expect(
        page.getByText(`If an account exists for ${email}, we sent an email`),
      ).toBeVisible();

      // Firebase really issued the reset email; choose a new password like the hosted page does.
      const code = await resetCodeFor(email);
      expect(code).toBeDefined();
      await chooseNewPassword(code!, NEW_PASSWORD);

      await page.getByRole('button', { name: 'Back to sign in' }).click();
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

      await submitLogin(page, email, PASSWORD);
      await expect(page.getByText('Incorrect email or password.')).toBeVisible();

      await submitLogin(page, email, NEW_PASSWORD);
      await expect(page.getByText(app.home)).toBeVisible();
    });

    test('shows the same neutral message for an unknown address and sends nothing', async ({
      page,
    }) => {
      const email = uniqueEmail(`nobody-${app.name}`);

      await openForgotPassword(page, app.url, app.title);
      await visibleEmail(page).fill(email);
      await page.getByRole('button', { name: 'Send reset link' }).click();

      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
      await expect(
        page.getByText(`If an account exists for ${email}, we sent an email`),
      ).toBeVisible();
      expect(await resetCodeFor(email)).toBeUndefined();
    });

    test('can go back to sign in without sending anything', async ({ page }) => {
      await openForgotPassword(page, app.url, app.title);
      await page.getByRole('button', { name: 'Back to sign in' }).click();
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    });

    test('limits how quickly the email can be sent again', async ({ page }) => {
      const email = uniqueEmail(`again-${app.name}`);
      await createAccount(email, app.role, true);

      await openForgotPassword(page, app.url, app.title);
      await visibleEmail(page).fill(email);
      await page.getByRole('button', { name: 'Send reset link' }).click();
      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

      await expect(page.getByRole('button', { name: /Send again in \d+s/ })).toBeDisabled();
    });
  });
}
