import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, apps, createAccount, openLogin, submitLogin, uniqueEmail } from './helpers';

async function openProfile(page: Page) {
  await page.getByRole('tab', { name: 'Profile' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
}

for (const app of apps) {
  test.describe(`${app.name} app sign-out`, () => {
    test('shows who is signed in and signs out after confirmation', async ({ page }) => {
      const email = uniqueEmail(`logout-${app.name}`);
      await createAccount(email, app.role, true, 'Grace Hopper');
      await openLogin(page, app.url, app.title);
      await submitLogin(page, email, PASSWORD);
      await expect(page.getByText(app.home)).toBeVisible();

      await openProfile(page);
      await expect(page.getByText('Grace Hopper')).toBeVisible();
      await expect(page.getByText(email)).toBeVisible();

      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Sign out?' })).toBeVisible();
      await expect(
        page.getByText(`You will need to sign in again to use ${app.title}.`),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Yes, sign out' }).click();

      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      await expect(page.getByText('Signed in as')).toHaveCount(0);
      await expect(page.getByText(app.home)).toHaveCount(0);
    });

    test('keeps the session when the person cancels', async ({ page }) => {
      const email = uniqueEmail(`cancel-${app.name}`);
      await createAccount(email, app.role, true);
      await openLogin(page, app.url, app.title);
      await submitLogin(page, email, PASSWORD);
      await openProfile(page);

      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Sign out?' })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel' }).click();

      await expect(page.getByRole('heading', { name: 'Sign out?' })).toHaveCount(0);
      await expect(page.getByText('Signed in as')).toBeVisible();

      await page.reload();
      await page.getByRole('tab', { name: 'Home' }).waitFor();
      await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible();
    });

    test('stays signed out after a reload and lets someone else sign in', async ({ page }) => {
      const first = uniqueEmail(`first-${app.name}`);
      const second = uniqueEmail(`second-${app.name}`);
      await createAccount(first, app.role, true, 'First Person');
      await createAccount(second, app.role, true, 'Second Person');

      await openLogin(page, app.url, app.title);
      await submitLogin(page, first, PASSWORD);
      await openProfile(page);
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('button', { name: 'Yes, sign out' }).click();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();

      // The stored session is gone: a reload does not bring the first person back.
      await page.reload();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Profile' })).toHaveCount(0);

      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await submitLogin(page, second, PASSWORD);
      await openProfile(page);
      await expect(page.getByText('Second Person')).toBeVisible();
      await expect(page.getByText('First Person')).toHaveCount(0);
    });
  });
}
