import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  PLACES,
  apps,
  createAccount,
  journeyId,
  openLogin,
  readDriverAvailability,
  readDriverJourney,
  submitLogin,
  uniqueEmail,
  writeDriverDoc,
  writeJourneyDoc,
  writeVehicleDoc,
} from './helpers';

const [passenger, driver] = apps;

async function signIn(page: Page, app: (typeof apps)[number], email: string) {
  await openLogin(page, app.url, app.title);
  await submitLogin(page, email, PASSWORD);
}

interface Setup {
  /** Passenger seats of the vehicle. Defaults to 4; null means none set yet. */
  capacity?: number | null;
  /** Whether the driver has a destination. Defaults to true. */
  destination?: boolean;
  /** Seats already on offer. Defaults to none. */
  seats?: number | null;
}

/** A verified driver with a verified vehicle, so only what a test changes stands in the way. */
async function newDriver(prefix: string, setup: Setup = {}) {
  const email = uniqueEmail(prefix);
  const uid = await createAccount(email, driver.role, true, 'Dan Driver', {
    name: 'Dan Driver',
    phone: '+44 7700 900123',
  });
  const withDestination = setup.destination !== false;
  // The journey already has a detour, so seats are the only thing standing in the way.
  if (withDestination) {
    await writeJourneyDoc(uid, PLACES.office, setup.seats ?? null, { minutes: 10, km: 5 });
  }
  await writeDriverDoc(uid, {
    verificationStatus: 'VERIFIED',
    currentJourneyId: withDestination ? journeyId(uid) : null,
  });
  await writeVehicleDoc(uid, {
    verificationStatus: 'VERIFIED',
    seatCapacity: setup.capacity === undefined ? 4 : setup.capacity,
  });
  return { email, uid };
}

const card = (page: Page) => page.getByLabel('Seats on offer', { exact: true });
const seat = (page: Page, count: number) =>
  card(page).getByRole('radio', { name: String(count), exact: true });
const save = (page: Page) => card(page).getByRole('button', { name: 'Save seats' });
const goOnline = (page: Page) => page.getByRole('button', { name: 'Go online', exact: true });
const checklist = (page: Page) => page.getByLabel('Before you can go online');

test.describe('driver app: seats on offer', () => {
  test('offers one seat up to the vehicle capacity, and nothing is chosen for the driver', async ({
    page,
  }) => {
    const { email } = await newDriver('seats-choices', { capacity: 3 });
    await signIn(page, driver, email);

    await expect(
      card(page).getByText('Not chosen yet. Your vehicle has 3 passenger seats.'),
    ).toBeVisible();
    for (const count of [1, 2, 3]) {
      await expect(seat(page, count)).toBeVisible();
      await expect(seat(page, count)).toHaveAttribute('aria-checked', 'false');
    }
    await expect(seat(page, 4)).toHaveCount(0);
    await expect(save(page)).toBeDisabled();
  });

  test('saves the seats, shows them after a reload, and lets the driver go online', async ({
    page,
  }) => {
    const { email, uid } = await newDriver('seats-save');
    await signIn(page, driver, email);

    await expect(goOnline(page)).toBeDisabled();
    await expect(checklist(page).getByText('Choose how many seats you offer below.')).toBeVisible();

    await seat(page, 2).click();
    await expect(seat(page, 2)).toHaveAttribute('aria-checked', 'true');
    await save(page).click();

    await expect(page.getByText('Your seats have been saved.')).toBeVisible();
    await expect.poll(() => readDriverJourney(uid)).toMatchObject({ availableSeats: 2 });
    await expect(goOnline(page)).toBeEnabled();
    await expect(checklist(page)).toHaveCount(0);
    await expect(save(page)).toBeDisabled();

    await page.reload();
    await expect(seat(page, 2)).toHaveAttribute('aria-checked', 'true');

    await goOnline(page).click();
    await expect(page.getByText('You are online')).toBeVisible();
    await expect.poll(() => readDriverAvailability(uid)).toBe('ONLINE');
  });

  test('can be changed later, and only saves when the number is different', async ({ page }) => {
    const { email, uid } = await newDriver('seats-change', { seats: 3 });
    await signIn(page, driver, email);

    await expect(seat(page, 3)).toHaveAttribute('aria-checked', 'true');
    await expect(save(page)).toBeDisabled();

    await seat(page, 1).click();
    await expect(save(page)).toBeEnabled();
    await seat(page, 3).click();
    await expect(save(page)).toBeDisabled();

    await seat(page, 4).click();
    await save(page).click();
    await expect(page.getByText('Your seats have been saved.')).toBeVisible();
    await expect.poll(() => readDriverJourney(uid)).toMatchObject({ availableSeats: 4 });
  });

  test('stays possible while online, and the driver stays online', async ({ page }) => {
    const { email, uid } = await newDriver('seats-online', { seats: 2 });
    await signIn(page, driver, email);
    await goOnline(page).click();
    await expect(page.getByText('You are online')).toBeVisible();

    await seat(page, 3).click();
    await save(page).click();

    await expect(page.getByText('Your seats have been saved.')).toBeVisible();
    await expect(page.getByText('You are online')).toBeVisible();
    await expect.poll(() => readDriverJourney(uid)).toMatchObject({ availableSeats: 3 });
    expect(await readDriverAvailability(uid)).toBe('ONLINE');
  });

  test('asks for the vehicle seats first, and follows them when they are set', async ({ page }) => {
    const { email, uid } = await newDriver('seats-nocapacity', { capacity: null });
    await signIn(page, driver, email);

    await expect(
      card(page).getByText('Set the passenger seats of your vehicle in the Profile tab first.'),
    ).toBeVisible();
    await expect(card(page).getByRole('radio')).toHaveCount(0);

    await writeVehicleDoc(uid, { verificationStatus: 'VERIFIED', seatCapacity: 2 });
    await expect(seat(page, 2)).toBeVisible();
    await expect(seat(page, 3)).toHaveCount(0);
  });

  test('asks for a destination first', async ({ page }) => {
    const { email } = await newDriver('seats-nodest', { destination: false });
    await signIn(page, driver, email);

    await expect(
      card(page).getByText('Set your destination first, then choose how many seats you offer.'),
    ).toBeVisible();
    await expect(card(page).getByRole('radio')).toHaveCount(0);
  });

  test('is lowered when the vehicle gets fewer seats', async ({ page }) => {
    const { email, uid } = await newDriver('seats-lowered', { capacity: 4, seats: 4 });
    await signIn(page, driver, email);
    await expect(seat(page, 4)).toHaveAttribute('aria-checked', 'true');

    await page.getByRole('tab', { name: 'Profile' }).click();
    await page.getByRole('radio', { name: '2', exact: true }).click();
    await page.getByRole('button', { name: 'Save seats' }).click();
    await expect(page.getByText('Your seats have been saved.')).toBeVisible();
    await expect.poll(() => readDriverJourney(uid)).toMatchObject({ availableSeats: 2 });

    await page.getByRole('tab', { name: 'Home' }).click();
    await expect(seat(page, 2)).toHaveAttribute('aria-checked', 'true');
    await expect(seat(page, 3)).toHaveCount(0);
  });
});

test.describe('passenger app: seats on offer', () => {
  test('has no seats to offer', async ({ page }) => {
    const email = uniqueEmail('seats-passenger');
    await createAccount(email, passenger.role, true, 'Pat Passenger', {
      name: 'Pat Passenger',
      phone: null,
    });
    await signIn(page, passenger, email);

    await expect(page.getByText(passenger.home)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });
});
