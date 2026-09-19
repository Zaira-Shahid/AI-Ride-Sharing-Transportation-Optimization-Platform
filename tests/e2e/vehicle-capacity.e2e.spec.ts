import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  apps,
  createAccount,
  openLogin,
  readVehicleDoc,
  submitLogin,
  uniqueEmail,
  writeVehicleDoc,
} from './helpers';

const [passenger, driver] = apps;

async function signInAndOpenProfile(page: Page, app: (typeof apps)[number], email: string) {
  await openLogin(page, app.url, app.title);
  await submitLogin(page, email, PASSWORD);
  await page.getByRole('tab', { name: 'Profile' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
}

async function driverWithVehicle(
  prefix: string,
  vehicle: Parameters<typeof writeVehicleDoc>[1] = {},
) {
  const email = uniqueEmail(prefix);
  const uid = await createAccount(email, driver.role, true, 'Dan Driver', {
    name: 'Dan Driver',
    phone: '+44 7700 900123',
  });
  await writeVehicleDoc(uid, vehicle);
  return { email, uid };
}

const card = (page: Page) => page.getByLabel('Your vehicle');
const seat = (page: Page, count: number) =>
  card(page).getByRole('radio', { name: String(count), exact: true });
const saveSeats = (page: Page) => page.getByRole('button', { name: 'Save seats' });
const REVIEW_HINT = 'More seats means your vehicle will be reviewed again.';

test.describe('driver app: passenger seats', () => {
  test('offers seats 1 to 6, saves the choice, and keeps it after a reload', async ({ page }) => {
    const { email, uid } = await driverWithVehicle('seats-set');
    await signInAndOpenProfile(page, driver, email);

    await expect(
      card(page).getByText('Not set yet. Count the seats for passengers, not your own.'),
    ).toBeVisible();
    await expect(card(page).getByRole('radio', { name: /^[1-6]$/ })).toHaveCount(6);
    await expect(card(page).getByRole('radio', { name: '7', exact: true })).toHaveCount(0);
    await expect(saveSeats(page)).toBeDisabled();

    await seat(page, 4).click();
    await expect(seat(page, 4)).toBeChecked();
    await expect(saveSeats(page)).toBeEnabled();
    await saveSeats(page).click();

    await expect(page.getByText('Your seats have been saved.')).toBeVisible();
    await expect.poll(() => readVehicleDoc(uid)).toMatchObject({ seatCapacity: 4 });
    await expect(saveSeats(page)).toBeDisabled();
    await expect(
      card(page).getByText('Seats for passengers, not counting your own.'),
    ).toBeVisible();

    await page.reload();
    await page.getByRole('tab', { name: 'Profile' }).click();
    await expect(seat(page, 4)).toBeChecked();
  });

  test('shows the stored seats and lets them be changed', async ({ page }) => {
    const { email, uid } = await driverWithVehicle('seats-change', { seatCapacity: 3 });
    await signInAndOpenProfile(page, driver, email);

    await expect(seat(page, 3)).toBeChecked();
    await seat(page, 5).click();
    await saveSeats(page).click();

    await expect(page.getByText('Your seats have been saved.')).toBeVisible();
    await expect.poll(() => readVehicleDoc(uid)).toMatchObject({ seatCapacity: 5 });
    await expect(seat(page, 5)).toBeChecked();
  });

  test('picking the stored number again leaves nothing to save', async ({ page }) => {
    const { email } = await driverWithVehicle('seats-same', { seatCapacity: 3 });
    await signInAndOpenProfile(page, driver, email);

    await seat(page, 5).click();
    await expect(saveSeats(page)).toBeEnabled();
    await seat(page, 3).click();
    await expect(saveSeats(page)).toBeDisabled();
  });

  test('warns that more seats mean a new review, and sends a verified vehicle back to pending', async ({
    page,
  }) => {
    const { email, uid } = await driverWithVehicle('seats-more', {
      seatCapacity: 3,
      verificationStatus: 'VERIFIED',
    });
    await signInAndOpenProfile(page, driver, email);
    await expect(card(page).getByText('Verified', { exact: true })).toBeVisible();
    await expect(page.getByText(REVIEW_HINT)).toHaveCount(0);

    await seat(page, 5).click();
    await expect(page.getByText(REVIEW_HINT)).toBeVisible();
    await saveSeats(page).click();

    await expect(card(page).getByText('Pending review')).toBeVisible();
    await expect(card(page).getByText('Verified', { exact: true })).toHaveCount(0);
    await expect
      .poll(() => readVehicleDoc(uid))
      .toMatchObject({ seatCapacity: 5, verificationStatus: 'PENDING' });
  });

  test('fewer seats need no new review', async ({ page }) => {
    const { email, uid } = await driverWithVehicle('seats-fewer', {
      seatCapacity: 5,
      verificationStatus: 'VERIFIED',
    });
    await signInAndOpenProfile(page, driver, email);

    await seat(page, 2).click();
    await expect(page.getByText(REVIEW_HINT)).toHaveCount(0);
    await saveSeats(page).click();

    await expect(page.getByText('Your seats have been saved.')).toBeVisible();
    await expect(card(page).getByText('Verified', { exact: true })).toBeVisible();
    await expect
      .poll(() => readVehicleDoc(uid))
      .toMatchObject({ seatCapacity: 2, verificationStatus: 'VERIFIED' });
  });

  test('editing the vehicle details keeps the seats', async ({ page }) => {
    const { email, uid } = await driverWithVehicle('seats-edit', { seatCapacity: 4 });
    await signInAndOpenProfile(page, driver, email);

    await page.getByRole('button', { name: 'Edit vehicle' }).click();
    await page.getByLabel('Model', { exact: true }).fill('Yaris');
    await page.getByRole('button', { name: 'Save vehicle' }).click();

    await expect(card(page).getByText('Toyota Yaris')).toBeVisible();
    await expect(seat(page, 4)).toBeChecked();
    expect(await readVehicleDoc(uid)).toMatchObject({ model: 'Yaris', seatCapacity: 4 });
  });

  test('shows no seat control until a vehicle has been added', async ({ page }) => {
    const email = uniqueEmail('seats-none');
    await createAccount(email, driver.role, true, 'Dan Driver', {
      name: 'Dan Driver',
      phone: null,
    });
    await signInAndOpenProfile(page, driver, email);

    await expect(page.getByRole('button', { name: 'Add vehicle' })).toBeVisible();
    await expect(page.getByText('Passenger seats')).toHaveCount(0);
    await expect(saveSeats(page)).toHaveCount(0);
  });
});

test.describe('passenger app: passenger seats', () => {
  test('never shows seats', async ({ page }) => {
    const email = uniqueEmail('seats-passenger');
    await createAccount(email, passenger.role, true, 'Pat Passenger', {
      name: 'Pat Passenger',
      phone: null,
    });
    await signInAndOpenProfile(page, passenger, email);

    await expect(page.getByLabel('Full name')).toHaveValue('Pat Passenger');
    await expect(page.getByText('Passenger seats')).toHaveCount(0);
  });
});
