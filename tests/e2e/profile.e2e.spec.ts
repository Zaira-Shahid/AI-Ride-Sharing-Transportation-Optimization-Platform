import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  apps,
  createAccount,
  openLogin,
  readProfileDoc,
  submitLogin,
  uniqueEmail,
} from './helpers';

const DRIVER_HINT = "You'll need to add a phone number before accepting rides.";

async function signInAndOpenProfile(page: Page, url: string, title: string, email: string) {
  await openLogin(page, url, title);
  await submitLogin(page, email, PASSWORD);
  await page.getByRole('tab', { name: 'Profile' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
}

const nameField = (page: Page) => page.getByLabel('Full name');
const phoneField = (page: Page) => page.getByLabel(/^Phone number/);
const saveButton = (page: Page) => page.getByRole('button', { name: 'Save changes' });

for (const app of apps) {
  test.describe(`${app.name} app profile`, () => {
    test('edits name and phone, and the change persists after a reload', async ({ page }) => {
      const email = uniqueEmail(`profile-${app.name}`);
      const uid = await createAccount(email, app.role, true, 'Old Name', {
        name: 'Old Name',
        phone: null,
      });

      await signInAndOpenProfile(page, app.url, app.title, email);
      await expect(nameField(page)).toHaveValue('Old Name');
      await expect(phoneField(page)).toHaveValue('');
      await expect(page.getByText(email)).toBeVisible();
      await expect(page.getByText('Your email address cannot be changed here.')).toBeVisible();

      await nameField(page).fill('Grace Hopper');
      await phoneField(page).fill('+44 7700 900123');
      await saveButton(page).click();

      await expect(page.getByText('Your details have been saved.')).toBeVisible();
      await expect(page.getByText('Grace Hopper', { exact: true }).first()).toBeVisible();
      await expect
        .poll(() => readProfileDoc(uid))
        .toEqual({
          name: 'Grace Hopper',
          phone: '+44 7700 900123',
          role: app.role,
        });

      await page.reload();
      await page.getByRole('tab', { name: 'Profile' }).click();
      await expect(nameField(page)).toHaveValue('Grace Hopper');
      await expect(phoneField(page)).toHaveValue('+44 7700 900123');
    });

    test('only enables saving once something changed', async ({ page }) => {
      const email = uniqueEmail(`dirty-${app.name}`);
      await createAccount(email, app.role, true, 'Same Name', { name: 'Same Name', phone: null });
      await signInAndOpenProfile(page, app.url, app.title, email);

      await expect(saveButton(page)).toBeDisabled();
      await nameField(page).fill('Different Name');
      await expect(saveButton(page)).toBeEnabled();
      await nameField(page).fill('Same Name');
      await expect(saveButton(page)).toBeDisabled();
    });

    test('rejects a blank name and an invalid phone without saving', async ({ page }) => {
      const email = uniqueEmail(`invalid-${app.name}`);
      const uid = await createAccount(email, app.role, true, 'Keep Me', {
        name: 'Keep Me',
        phone: null,
      });
      await signInAndOpenProfile(page, app.url, app.title, email);

      await nameField(page).fill('   ');
      await phoneField(page).fill('abc');
      await saveButton(page).click();

      await expect(page.getByText('Enter your full name.')).toBeVisible();
      await expect(page.getByText('Enter a valid phone number, or leave it empty.')).toBeVisible();
      await expect(page.getByText('Your details have been saved.')).toHaveCount(0);
      expect(await readProfileDoc(uid)).toMatchObject({ name: 'Keep Me', phone: null });
    });

    test('lets the phone number be cleared', async ({ page }) => {
      const email = uniqueEmail(`clear-${app.name}`);
      const uid = await createAccount(email, app.role, true, 'Has Phone', {
        name: 'Has Phone',
        phone: '+44 7700 900123',
      });
      await signInAndOpenProfile(page, app.url, app.title, email);

      await phoneField(page).fill('');
      await saveButton(page).click();

      await expect(page.getByText('Your details have been saved.')).toBeVisible();
      await expect.poll(() => readProfileDoc(uid)).toMatchObject({ phone: null });
    });

    test('shows a friendly message and still allows sign-out when the profile cannot be loaded', async ({
      page,
    }) => {
      const email = uniqueEmail(`missing-${app.name}`);
      await createAccount(email, app.role, true, 'No Profile Doc');
      await signInAndOpenProfile(page, app.url, app.title, email);

      await expect(
        page.getByText('We could not load your profile details. Please try again.'),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
      await expect(nameField(page)).toHaveCount(0);

      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('button', { name: 'Yes, sign out' }).click();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    });
  });
}

test.describe('driver phone hint', () => {
  const driver = apps[1];
  const passenger = apps[0];

  test('shows for a driver without a phone, and goes away once a phone is saved', async ({
    page,
  }) => {
    const email = uniqueEmail('hint-driver');
    await createAccount(email, driver.role, true, 'Dan Driver', {
      name: 'Dan Driver',
      phone: null,
    });
    await signInAndOpenProfile(page, driver.url, driver.title, email);

    await expect(page.getByText(DRIVER_HINT)).toBeVisible();

    await phoneField(page).fill('+44 7700 900123');
    await saveButton(page).click();
    await expect(page.getByText('Your details have been saved.')).toBeVisible();
    await expect(page.getByText(DRIVER_HINT)).toHaveCount(0);
  });

  test('comes back when a driver clears their phone', async ({ page }) => {
    const email = uniqueEmail('hint-cleared');
    await createAccount(email, driver.role, true, 'Dan Driver', {
      name: 'Dan Driver',
      phone: '+44 7700 900123',
    });
    await signInAndOpenProfile(page, driver.url, driver.title, email);
    await expect(page.getByText(DRIVER_HINT)).toHaveCount(0);

    await phoneField(page).fill('');
    await saveButton(page).click();
    await expect(page.getByText(DRIVER_HINT)).toBeVisible();
  });

  test('is never shown to a passenger', async ({ page }) => {
    const email = uniqueEmail('hint-passenger');
    await createAccount(email, passenger.role, true, 'Pat Passenger', {
      name: 'Pat Passenger',
      phone: null,
    });
    await signInAndOpenProfile(page, passenger.url, passenger.title, email);

    await expect(nameField(page)).toHaveValue('Pat Passenger');
    await expect(page.getByText(DRIVER_HINT)).toHaveCount(0);
    await expect(page.getByText(/before accepting rides/)).toHaveCount(0);
  });
});
