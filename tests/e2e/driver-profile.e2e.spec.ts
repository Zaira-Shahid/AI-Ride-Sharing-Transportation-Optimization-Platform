import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  apps,
  createAccount,
  deleteDriverDoc,
  openLogin,
  submitLogin,
  uniqueEmail,
  writeDriverDoc,
} from './helpers';

const [passenger, driver] = apps;

async function signInAndOpenProfile(page: Page, app: (typeof apps)[number], email: string) {
  await openLogin(page, app.url, app.title);
  await submitLogin(page, email, PASSWORD);
  await page.getByRole('tab', { name: 'Profile' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
}

const details = (page: Page) => page.getByLabel('Driver details');

test.describe('driver app: driver profile', () => {
  test('shows a new driver as pending review with no trips or ratings', async ({ page }) => {
    const email = uniqueEmail('driver-new');
    await createAccount(email, driver.role, true, 'Dan Driver', {
      name: 'Dan Driver',
      phone: '+44 7700 900123',
    });
    await signInAndOpenProfile(page, driver, email);

    await expect(details(page)).toBeVisible();
    await expect(details(page).getByText('Pending review')).toBeVisible();
    await expect(details(page).getByText('0', { exact: true })).toBeVisible();
    await expect(details(page).getByText('No ratings yet')).toBeVisible();
    // The name and phone form from Module 1.6 is still there.
    await expect(page.getByLabel('Full name')).toHaveValue('Dan Driver');
  });

  test('shows the stored verification status, trips and rating', async ({ page }) => {
    const email = uniqueEmail('driver-stored');
    const uid = await createAccount(email, driver.role, true, 'Vera Verified', {
      name: 'Vera Verified',
      phone: null,
    });
    await writeDriverDoc(uid, { verificationStatus: 'VERIFIED', totalTrips: 12, rating: 4.86 });
    await signInAndOpenProfile(page, driver, email);

    await expect(details(page).getByText('Verified', { exact: true })).toBeVisible();
    await expect(details(page).getByText('12', { exact: true })).toBeVisible();
    await expect(details(page).getByText('4.9', { exact: true })).toBeVisible();
    await expect(details(page).getByText('Pending review')).toHaveCount(0);
  });

  test('shows a rejected driver as not approved', async ({ page }) => {
    const email = uniqueEmail('driver-rejected');
    const uid = await createAccount(email, driver.role, true, 'Rita Rejected', {
      name: 'Rita Rejected',
      phone: null,
    });
    await writeDriverDoc(uid, { verificationStatus: 'REJECTED' });
    await signInAndOpenProfile(page, driver, email);

    await expect(details(page).getByText('Not approved')).toBeVisible();
  });

  test('updates without a reload when the status changes', async ({ page }) => {
    const email = uniqueEmail('driver-live');
    const uid = await createAccount(email, driver.role, true, 'Liv Live', {
      name: 'Liv Live',
      phone: null,
    });
    await signInAndOpenProfile(page, driver, email);
    await expect(details(page).getByText('Pending review')).toBeVisible();

    await writeDriverDoc(uid, { verificationStatus: 'VERIFIED' });
    await expect(details(page).getByText('Verified', { exact: true })).toBeVisible();
  });

  test('explains a missing driver profile, keeps the rest usable, and recovers once it exists', async ({
    page,
  }) => {
    const email = uniqueEmail('driver-missing');
    const uid = await createAccount(email, driver.role, true, 'Mo Missing', {
      name: 'Mo Missing',
      phone: null,
    });
    await deleteDriverDoc(uid);
    await signInAndOpenProfile(page, driver, email);

    await expect(
      page.getByText('We could not load your driver details. Please try again.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(details(page)).toHaveCount(0);
    await expect(page.getByLabel('Full name')).toHaveValue('Mo Missing');

    // The screen keeps listening, so it recovers by itself once the profile is created.
    await writeDriverDoc(uid);
    await expect(details(page).getByText('Pending review')).toBeVisible();
    await expect(page.getByText('We could not load your driver details.')).toHaveCount(0);
  });
});

test.describe('passenger app: driver profile', () => {
  test('never shows driver details', async ({ page }) => {
    const email = uniqueEmail('passenger-nodriver');
    await createAccount(email, passenger.role, true, 'Pat Passenger', {
      name: 'Pat Passenger',
      phone: null,
    });
    await signInAndOpenProfile(page, passenger, email);

    await expect(page.getByLabel('Full name')).toHaveValue('Pat Passenger');
    await expect(details(page)).toHaveCount(0);
    await expect(page.getByText('Verification')).toHaveCount(0);
    await expect(page.getByText(/driver details/i)).toHaveCount(0);
  });
});
