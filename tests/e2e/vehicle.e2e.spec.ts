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

async function newDriver(prefix: string) {
  const email = uniqueEmail(prefix);
  const uid = await createAccount(email, driver.role, true, 'Dan Driver', {
    name: 'Dan Driver',
    phone: '+44 7700 900123',
  });
  return { email, uid };
}

const card = (page: Page) => page.getByLabel('Your vehicle');
const form = (page: Page) => page.getByLabel('Vehicle form');
const saveButton = (page: Page) => page.getByRole('button', { name: 'Save vehicle' });
const make = (page: Page) => page.getByLabel('Make', { exact: true });
const model = (page: Page) => page.getByLabel('Model', { exact: true });
const plate = (page: Page) => page.getByLabel('Plate number');

test.describe('driver app: vehicle', () => {
  test('adds a vehicle, tidies the plate, and shows it as pending review', async ({ page }) => {
    const { email, uid } = await newDriver('veh-add');
    await signInAndOpenProfile(page, driver, email);

    await expect(
      card(page).getByText('Add the vehicle you will drive so it can be reviewed.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Add vehicle' }).click();
    await expect(form(page)).toBeVisible();

    await saveButton(page).click();
    await expect(page.getByText('Choose your vehicle type.')).toBeVisible();
    await expect(page.getByText('Enter the make, for example Toyota.')).toBeVisible();
    await expect(page.getByText('Enter the model, for example Corolla.')).toBeVisible();
    await expect(page.getByText('Enter your plate number.')).toBeVisible();
    expect(await readVehicleDoc(uid)).toBeUndefined();

    await page.getByRole('radio', { name: 'Van' }).click();
    await make(page).fill('Ford');
    await model(page).fill('Transit');
    await plate(page).fill(' ab 12  cd ');
    await saveButton(page).click();

    await expect(page.getByText('Your vehicle has been saved.')).toBeVisible();
    await expect(form(page)).toHaveCount(0);
    await expect(card(page).getByText('Van', { exact: true })).toBeVisible();
    await expect(card(page).getByText('Ford Transit')).toBeVisible();
    await expect(card(page).getByText('AB 12 CD')).toBeVisible();
    await expect(card(page).getByText('Pending review')).toBeVisible();
    await expect
      .poll(() => readVehicleDoc(uid))
      .toEqual({
        type: 'VAN',
        make: 'Ford',
        model: 'Transit',
        plateNumber: 'AB 12 CD',
        seatCapacity: null,
        verificationStatus: 'PENDING',
      });

    await page.reload();
    await page.getByRole('tab', { name: 'Profile' }).click();
    await expect(card(page).getByText('Ford Transit')).toBeVisible();
  });

  test('cancelling the form saves nothing', async ({ page }) => {
    const { email, uid } = await newDriver('veh-cancel');
    await signInAndOpenProfile(page, driver, email);

    await page.getByRole('button', { name: 'Add vehicle' }).click();
    await make(page).fill('Ford');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(form(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add vehicle' })).toBeVisible();
    expect(await readVehicleDoc(uid)).toBeUndefined();
  });

  test('shows an existing vehicle and its verification status', async ({ page }) => {
    const { email, uid } = await newDriver('veh-show');
    await writeVehicleDoc(uid, {
      type: 'MINIBUS',
      make: 'Mercedes',
      model: 'Sprinter',
      plateNumber: 'BUS 500',
      verificationStatus: 'VERIFIED',
    });
    await signInAndOpenProfile(page, driver, email);

    await expect(card(page).getByText('Minibus')).toBeVisible();
    await expect(card(page).getByText('Mercedes Sprinter')).toBeVisible();
    await expect(card(page).getByText('BUS 500')).toBeVisible();
    await expect(card(page).getByText('Verified', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add vehicle' })).toHaveCount(0);
  });

  test('edits a vehicle, warning that a verified one is reviewed again', async ({ page }) => {
    const { email, uid } = await newDriver('veh-edit');
    await writeVehicleDoc(uid, {
      model: 'Corolla',
      plateNumber: 'EDIT 100',
      verificationStatus: 'VERIFIED',
    });
    await signInAndOpenProfile(page, driver, email);

    await page.getByRole('button', { name: 'Edit vehicle' }).click();
    await expect(
      form(page).getByText('Changing these details means your vehicle will be reviewed again.'),
    ).toBeVisible();
    await expect(make(page)).toHaveValue('Toyota');
    await expect(model(page)).toHaveValue('Corolla');
    await expect(plate(page)).toHaveValue('EDIT 100');
    await expect(page.getByRole('radio', { name: 'Car' })).toBeChecked();

    await model(page).fill('Yaris');
    await saveButton(page).click();

    await expect(card(page).getByText('Toyota Yaris')).toBeVisible();
    await expect(card(page).getByText('Pending review')).toBeVisible();
    await expect(card(page).getByText('Verified', { exact: true })).toHaveCount(0);
    await expect
      .poll(() => readVehicleDoc(uid))
      .toMatchObject({ model: 'Yaris', verificationStatus: 'PENDING' });
  });

  test('refuses a plate number that another driver already has', async ({ page }) => {
    const other = await newDriver('veh-owner');
    await writeVehicleDoc(other.uid, { plateNumber: 'TAKEN-77' });
    const { email, uid } = await newDriver('veh-conflict');
    await signInAndOpenProfile(page, driver, email);

    await page.getByRole('button', { name: 'Add vehicle' }).click();
    await page.getByRole('radio', { name: 'Car' }).click();
    await make(page).fill('Honda');
    await model(page).fill('Civic');
    await plate(page).fill('taken 77');
    await saveButton(page).click();

    await expect(
      page.getByText('This plate number is already registered to another vehicle.'),
    ).toBeVisible();
    await expect(form(page)).toBeVisible();
    await expect(make(page)).toHaveValue('Honda');
    expect(await readVehicleDoc(uid)).toBeUndefined();
    expect(await readVehicleDoc(other.uid)).toMatchObject({ plateNumber: 'TAKEN-77' });
  });
});

test.describe('passenger app: vehicle', () => {
  test('never shows a vehicle section', async ({ page }) => {
    const email = uniqueEmail('veh-passenger');
    await createAccount(email, passenger.role, true, 'Pat Passenger', {
      name: 'Pat Passenger',
      phone: null,
    });
    await signInAndOpenProfile(page, passenger, email);

    await expect(page.getByLabel('Full name')).toHaveValue('Pat Passenger');
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add vehicle' })).toHaveCount(0);
  });
});
