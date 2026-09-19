import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  apps,
  createAccount,
  openLogin,
  readDriverVerification,
  readVehicleDoc,
  submitLogin,
  uniqueEmail,
  writeDriverDoc,
  writeVehicleDoc,
} from './helpers';

const [passenger, driver] = apps;

async function signInAndOpenProfile(page: Page, app: (typeof apps)[number], email: string) {
  await openLogin(page, app.url, app.title);
  await submitLogin(page, email, PASSWORD);
  await page.getByRole('tab', { name: 'Profile' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
}

async function newDriver(prefix: string) {
  const email = uniqueEmail(prefix);
  const uid = await createAccount(email, driver.role, true, 'Dan Driver', {
    name: 'Dan Driver',
    phone: '+44 7700 900123',
  });
  return { email, uid };
}

const driverCard = (page: Page) => page.getByLabel('Driver details');
const vehicleCard = (page: Page) => page.getByLabel('Your vehicle');
const NOT_REVIEWED = 'Our team has not reviewed this yet.';

test.describe('driver app: verification', () => {
  test('shows a new driver and vehicle as waiting for review, with nothing to request', async ({
    page,
  }) => {
    const { email, uid } = await newDriver('ver-pending');
    await writeVehicleDoc(uid);
    await signInAndOpenProfile(page, driver, email);

    for (const card of [driverCard(page), vehicleCard(page)]) {
      await expect(card.getByText('Pending review')).toBeVisible();
      await expect(card.getByText(NOT_REVIEWED)).toBeVisible();
      await expect(card.getByRole('button', { name: /^Request .* review$/ })).toHaveCount(0);
    }
  });

  test('shows a verified driver and vehicle with no request button', async ({ page }) => {
    const { email, uid } = await newDriver('ver-verified');
    await writeDriverDoc(uid, { verificationStatus: 'VERIFIED' });
    await writeVehicleDoc(uid, { verificationStatus: 'VERIFIED' });
    await signInAndOpenProfile(page, driver, email);

    for (const card of [driverCard(page), vehicleCard(page)]) {
      await expect(card.getByText('Verified', { exact: true })).toBeVisible();
      await expect(card.getByText(NOT_REVIEWED)).toHaveCount(0);
      await expect(card.getByText(/^Reason:/)).toHaveCount(0);
      await expect(card.getByRole('button', { name: /^Request .* review$/ })).toHaveCount(0);
    }
  });

  test('shows why a driver was rejected and lets them ask for a new review', async ({ page }) => {
    const { email, uid } = await newDriver('ver-driver-rejected');
    await writeDriverDoc(uid, {
      verificationStatus: 'REJECTED',
      verificationReason: 'Identity could not be confirmed.',
    });
    await signInAndOpenProfile(page, driver, email);

    await expect(driverCard(page).getByText('Not approved')).toBeVisible();
    await expect(
      driverCard(page).getByText('Reason: Identity could not be confirmed.'),
    ).toBeVisible();

    await driverCard(page).getByRole('button', { name: 'Request driver review' }).click();

    await expect(driverCard(page).getByText('Pending review')).toBeVisible();
    await expect(driverCard(page).getByText(/^Reason:/)).toHaveCount(0);
    await expect(
      driverCard(page).getByRole('button', { name: 'Request driver review' }),
    ).toHaveCount(0);
    await expect
      .poll(() => readDriverVerification(uid))
      .toEqual({ verificationStatus: 'PENDING', verificationReason: null });
  });

  test('shows why a vehicle was rejected and lets the driver ask again', async ({ page }) => {
    const { email, uid } = await newDriver('ver-vehicle-rejected');
    await writeVehicleDoc(uid, {
      verificationStatus: 'REJECTED',
      verificationReason: 'Plate does not match.',
    });
    await signInAndOpenProfile(page, driver, email);

    await expect(vehicleCard(page).getByText('Not approved')).toBeVisible();
    await expect(vehicleCard(page).getByText('Reason: Plate does not match.')).toBeVisible();
    // The driver profile is a separate decision and is unaffected.
    await expect(driverCard(page).getByText('Pending review')).toBeVisible();

    await vehicleCard(page).getByRole('button', { name: 'Request vehicle review' }).click();

    await expect(vehicleCard(page).getByText('Pending review')).toBeVisible();
    await expect(vehicleCard(page).getByText(/^Reason:/)).toHaveCount(0);
    await expect
      .poll(() => readVehicleDoc(uid))
      .toMatchObject({ verificationStatus: 'PENDING', verificationReason: null });
    expect(await readDriverVerification(uid)).toMatchObject({ verificationStatus: 'PENDING' });
  });

  test('says so when a rejection came without a reason', async ({ page }) => {
    const { email, uid } = await newDriver('ver-no-reason');
    await writeDriverDoc(uid, { verificationStatus: 'REJECTED' });
    await signInAndOpenProfile(page, driver, email);

    await expect(driverCard(page).getByText('No reason was given.')).toBeVisible();
  });

  test('follows a staff decision live, without a reload', async ({ page }) => {
    const { email, uid } = await newDriver('ver-live');
    await signInAndOpenProfile(page, driver, email);
    await expect(driverCard(page).getByText('Pending review')).toBeVisible();

    await writeDriverDoc(uid, {
      verificationStatus: 'REJECTED',
      verificationReason: 'Licence has expired.',
    });
    await expect(driverCard(page).getByText('Reason: Licence has expired.')).toBeVisible();

    await writeDriverDoc(uid, { verificationStatus: 'VERIFIED' });
    await expect(driverCard(page).getByText('Verified', { exact: true })).toBeVisible();
    await expect(driverCard(page).getByText(/^Reason:/)).toHaveCount(0);
  });
});

test.describe('passenger app: verification', () => {
  test('shows no verification information', async ({ page }) => {
    const email = uniqueEmail('ver-passenger');
    await createAccount(email, passenger.role, true, 'Pat Passenger', {
      name: 'Pat Passenger',
      phone: null,
    });
    await signInAndOpenProfile(page, passenger, email);

    await expect(page.getByLabel('Full name')).toHaveValue('Pat Passenger');
    await expect(page.getByText('Verification')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Request .* review$/ })).toHaveCount(0);
  });
});
