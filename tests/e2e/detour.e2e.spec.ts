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
  /** Whether the driver has a destination. Defaults to true. */
  destination?: boolean;
  /** Limits already on the journey. Defaults to none chosen. */
  detour?: { minutes: number; km: number } | null;
}

/** A verified driver and vehicle with seats on offer, so only the detour stands in the way. */
async function newDriver(prefix: string, setup: Setup = {}) {
  const email = uniqueEmail(prefix);
  const uid = await createAccount(email, driver.role, true, 'Dan Driver', {
    name: 'Dan Driver',
    phone: '+44 7700 900123',
  });
  const withDestination = setup.destination !== false;
  if (withDestination) await writeJourneyDoc(uid, PLACES.office, 3, setup.detour ?? null);
  await writeDriverDoc(uid, {
    verificationStatus: 'VERIFIED',
    currentJourneyId: withDestination ? journeyId(uid) : null,
  });
  await writeVehicleDoc(uid, { verificationStatus: 'VERIFIED', seatCapacity: 4 });
  return { email, uid };
}

const card = (page: Page) => page.getByLabel('Maximum detour', { exact: true });
const minutes = (page: Page, count: number) =>
  card(page).getByRole('radio', { name: `${count} min`, exact: true });
const km = (page: Page, count: number) =>
  card(page).getByRole('radio', { name: `${count} km`, exact: true });
const save = (page: Page) => card(page).getByRole('button', { name: 'Save detour' });
const goOnline = (page: Page) => page.getByRole('button', { name: 'Go online', exact: true });
const checklist = (page: Page) => page.getByLabel('Before you can go online');

test.describe('driver app: maximum detour', () => {
  test('offers minutes and kilometres as presets, and nothing is chosen for the driver', async ({
    page,
  }) => {
    const { email } = await newDriver('detour-choices');
    await signIn(page, driver, email);

    await expect(card(page).getByText('Not chosen yet. Choose both.')).toBeVisible();
    for (const count of [5, 10, 15, 20, 30]) {
      await expect(minutes(page, count)).toBeVisible();
      await expect(minutes(page, count)).toHaveAttribute('aria-checked', 'false');
    }
    for (const count of [1, 2, 5, 10, 15]) {
      await expect(km(page, count)).toBeVisible();
      await expect(km(page, count)).toHaveAttribute('aria-checked', 'false');
    }
    await expect(save(page)).toBeDisabled();
  });

  test('needs both limits before it can be saved', async ({ page }) => {
    const { email } = await newDriver('detour-both');
    await signIn(page, driver, email);

    await minutes(page, 10).click();
    await expect(save(page)).toBeDisabled();
    await km(page, 5).click();
    await expect(save(page)).toBeEnabled();
  });

  test('saves both limits, shows them after a reload, and lets the driver go online', async ({
    page,
  }) => {
    const { email, uid } = await newDriver('detour-save');
    await signIn(page, driver, email);

    await expect(goOnline(page)).toBeDisabled();
    await expect(
      checklist(page).getByText('Choose how far you will go out of your way below.'),
    ).toBeVisible();

    await minutes(page, 10).click();
    await km(page, 5).click();
    await save(page).click();

    await expect(page.getByText('Your detour limits have been saved.')).toBeVisible();
    await expect
      .poll(() => readDriverJourney(uid))
      .toMatchObject({ maxDetourMinutes: 10, maxDetourDistance: 5 });
    await expect(goOnline(page)).toBeEnabled();
    await expect(checklist(page)).toHaveCount(0);
    await expect(save(page)).toBeDisabled();

    await page.reload();
    await expect(minutes(page, 10)).toHaveAttribute('aria-checked', 'true');
    await expect(km(page, 5)).toHaveAttribute('aria-checked', 'true');

    await goOnline(page).click();
    await expect(page.getByText('You are online')).toBeVisible();
    await expect.poll(() => readDriverAvailability(uid)).toBe('ONLINE');
  });

  test('can be changed later, and only saves when something is different', async ({ page }) => {
    const { email, uid } = await newDriver('detour-change', { detour: { minutes: 10, km: 5 } });
    await signIn(page, driver, email);

    await expect(minutes(page, 10)).toHaveAttribute('aria-checked', 'true');
    await expect(km(page, 5)).toHaveAttribute('aria-checked', 'true');
    await expect(save(page)).toBeDisabled();

    await minutes(page, 20).click();
    await expect(save(page)).toBeEnabled();
    await minutes(page, 10).click();
    await expect(save(page)).toBeDisabled();

    await km(page, 15).click();
    await save(page).click();
    await expect(page.getByText('Your detour limits have been saved.')).toBeVisible();
    await expect
      .poll(() => readDriverJourney(uid))
      .toMatchObject({ maxDetourMinutes: 10, maxDetourDistance: 15 });
  });

  test('stays possible while online, and the driver stays online', async ({ page }) => {
    const { email, uid } = await newDriver('detour-online', { detour: { minutes: 10, km: 5 } });
    await signIn(page, driver, email);
    await goOnline(page).click();
    await expect(page.getByText('You are online')).toBeVisible();

    await minutes(page, 30).click();
    await save(page).click();

    await expect(page.getByText('Your detour limits have been saved.')).toBeVisible();
    await expect(page.getByText('You are online')).toBeVisible();
    await expect
      .poll(() => readDriverJourney(uid))
      .toMatchObject({ maxDetourMinutes: 30, maxDetourDistance: 5 });
    expect(await readDriverAvailability(uid)).toBe('ONLINE');
  });

  test('asks for a destination first', async ({ page }) => {
    const { email } = await newDriver('detour-nodest', { destination: false });
    await signIn(page, driver, email);

    await expect(
      card(page).getByText(
        'Set your destination first, then choose how far you will go out of your way.',
      ),
    ).toBeVisible();
    await expect(card(page).getByRole('radio')).toHaveCount(0);
  });
});

test.describe('passenger app: maximum detour', () => {
  test('has no detour to set', async ({ page }) => {
    const email = uniqueEmail('detour-passenger');
    await createAccount(email, passenger.role, true, 'Pat Passenger', {
      name: 'Pat Passenger',
      phone: null,
    });
    await signIn(page, passenger, email);

    await expect(page.getByText(passenger.home)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });
});
