import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  PLACES,
  apps,
  createAccount,
  journeyId,
  openLogin,
  readDriverAvailability,
  reviewAsAdmin,
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
  driver?: Parameters<typeof writeDriverDoc>[1];
  vehicle?: Parameters<typeof writeVehicleDoc>[1] | null;
  /** Whether the driver has a destination. Defaults to true. */
  destination?: boolean;
  /** Seats on offer on the journey. Defaults to 3; only used with a destination. */
  seats?: number | null;
}

/** A driver account with a profile, and the driver and vehicle records a test asks for. */
async function newDriver(prefix: string, setup: Setup = {}) {
  const email = uniqueEmail(prefix);
  const uid = await createAccount(email, driver.role, true, 'Dan Driver', {
    name: 'Dan Driver',
    phone: '+44 7700 900123',
  });
  const withDestination = setup.destination !== false;
  if (withDestination) await writeJourneyDoc(uid, PLACES.office, setup.seats ?? 3);
  await writeDriverDoc(uid, {
    ...setup.driver,
    currentJourneyId: withDestination ? journeyId(uid) : null,
  });
  if (setup.vehicle !== null) await writeVehicleDoc(uid, setup.vehicle);
  return { email, uid };
}

const READY: Setup = {
  driver: { verificationStatus: 'VERIFIED' },
  vehicle: { verificationStatus: 'VERIFIED', seatCapacity: 4 },
};

const goOnline = (page: Page) => page.getByRole('button', { name: 'Go online', exact: true });
const goOffline = (page: Page) => page.getByRole('button', { name: 'Go offline', exact: true });
const checklist = (page: Page) => page.getByLabel('Before you can go online');
const OFFLINE = 'You are offline';
const ONLINE = 'You are online';

test.describe('driver app: going online', () => {
  test('goes online and offline, and stays online after a reload', async ({ page }) => {
    const { email, uid } = await newDriver('avl-toggle', READY);
    await signIn(page, driver, email);

    await expect(page.getByText(OFFLINE)).toBeVisible();
    await expect(goOnline(page)).toBeEnabled();
    await expect(checklist(page)).toHaveCount(0);

    await goOnline(page).click();
    await expect(page.getByText(ONLINE)).toBeVisible();
    await expect(goOffline(page)).toBeVisible();
    await expect(goOnline(page)).toHaveCount(0);
    await expect.poll(() => readDriverAvailability(uid)).toBe('ONLINE');

    await page.reload();
    await expect(page.getByText(ONLINE)).toBeVisible();

    await goOffline(page).click();
    await expect(page.getByText(OFFLINE)).toBeVisible();
    await expect.poll(() => readDriverAvailability(uid)).toBe('OFFLINE');
  });

  test('cannot go online yet: the button is off and the list says what is left', async ({
    page,
  }) => {
    const { email, uid } = await newDriver('avl-new', { vehicle: null, destination: false });
    await signIn(page, driver, email);

    await expect(page.getByText(OFFLINE)).toBeVisible();
    await expect(goOnline(page)).toBeDisabled();
    await expect(checklist(page).getByText('Account active')).toBeVisible();
    await expect(
      checklist(page).getByText('Your driver profile is waiting to be verified.'),
    ).toBeVisible();
    await expect(checklist(page).getByText('Add your vehicle in the Profile tab.')).toBeVisible();
    await expect(checklist(page).getByText('Your vehicle needs to be verified.')).toBeVisible();
    await expect(
      checklist(page).getByText('Set your passenger seats in the Profile tab.'),
    ).toBeVisible();
    await expect(checklist(page).getByText('Set your destination below.')).toBeVisible();
    await expect(checklist(page).getByText('Choose how many seats you offer below.')).toBeVisible();
    expect(await readDriverAvailability(uid)).toBe('OFFLINE');
  });

  test('ticks requirements off as they are met, and enables the button at the end', async ({
    page,
  }) => {
    const { email, uid } = await newDriver('avl-progress', { vehicle: null });
    await signIn(page, driver, email);
    await expect(goOnline(page)).toBeDisabled();

    await writeDriverDoc(uid, { verificationStatus: 'VERIFIED', currentJourneyId: journeyId(uid) });
    await expect(checklist(page).getByText('Driver profile verified')).toBeVisible();
    await expect(checklist(page).getByText('Destination set')).toBeVisible();
    await expect(goOnline(page)).toBeDisabled();

    await writeVehicleDoc(uid, { verificationStatus: 'PENDING' });
    await expect(checklist(page).getByText('Vehicle added')).toBeVisible();
    await expect(checklist(page).getByText('Your vehicle needs to be verified.')).toBeVisible();
    await expect(
      checklist(page).getByText('Set your passenger seats in the Profile tab.'),
    ).toBeVisible();
    // Seats on offer count only once the vehicle they are offered in has its seats.
    await expect(checklist(page).getByText('Choose how many seats you offer below.')).toBeVisible();

    await writeVehicleDoc(uid, { verificationStatus: 'VERIFIED', seatCapacity: 3 });
    await expect(goOnline(page)).toBeEnabled();
    await expect(checklist(page)).toHaveCount(0);
  });

  test('says when the driver profile or the vehicle was not approved', async ({ page }) => {
    const { email } = await newDriver('avl-rejected', {
      driver: { verificationStatus: 'REJECTED', verificationReason: 'No.' },
      vehicle: { verificationStatus: 'REJECTED', verificationReason: 'No.', seatCapacity: 4 },
    });
    await signIn(page, driver, email);

    await expect(goOnline(page)).toBeDisabled();
    await expect(
      checklist(page).getByText('Your driver profile was not approved. See the Profile tab.'),
    ).toBeVisible();
    await expect(
      checklist(page).getByText('Your vehicle was not approved. See the Profile tab.'),
    ).toBeVisible();
  });

  test('is taken offline at once when staff reject the vehicle', async ({ page }) => {
    const { email, uid } = await newDriver('avl-forced', READY);
    await signIn(page, driver, email);
    await goOnline(page).click();
    await expect(page.getByText(ONLINE)).toBeVisible();

    await reviewAsAdmin('vehicle', uid, 'REJECTED', 'Photo is unclear.');

    await expect(page.getByText(OFFLINE)).toBeVisible();
    await expect(goOnline(page)).toBeDisabled();
    await expect(
      checklist(page).getByText('Your vehicle was not approved. See the Profile tab.'),
    ).toBeVisible();
    expect(await readDriverAvailability(uid)).toBe('OFFLINE');
  });

  test('is taken offline when the driver profile is rejected, and can return once verified again', async ({
    page,
  }) => {
    const { email, uid } = await newDriver('avl-forced-driver', READY);
    await signIn(page, driver, email);
    await goOnline(page).click();
    await expect(page.getByText(ONLINE)).toBeVisible();

    await reviewAsAdmin('driver', uid, 'REJECTED', 'Identity could not be confirmed.');
    await expect(page.getByText(OFFLINE)).toBeVisible();
    await expect(goOnline(page)).toBeDisabled();

    await reviewAsAdmin('driver', uid, 'VERIFIED');
    await expect(goOnline(page)).toBeEnabled();
    await goOnline(page).click();
    await expect(page.getByText(ONLINE)).toBeVisible();
  });

  test('is taken offline when the driver edits the vehicle, which needs a new review', async ({
    page,
  }) => {
    const { email, uid } = await newDriver('avl-edit', READY);
    await signIn(page, driver, email);
    await goOnline(page).click();
    await expect(page.getByText(ONLINE)).toBeVisible();

    await page.getByRole('tab', { name: 'Profile' }).click();
    await page.getByRole('button', { name: 'Edit vehicle' }).click();
    await page.getByLabel('Model', { exact: true }).fill('Yaris');
    await page.getByRole('button', { name: 'Save vehicle' }).click();
    await expect(page.getByLabel('Your vehicle').getByText('Pending review')).toBeVisible();

    await page.getByRole('tab', { name: 'Home' }).click();
    await expect(page.getByText(OFFLINE)).toBeVisible();
    await expect(goOnline(page)).toBeDisabled();
    expect(await readDriverAvailability(uid)).toBe('OFFLINE');
  });
});

test.describe('passenger app: home', () => {
  test('has no online or offline switch', async ({ page }) => {
    const email = uniqueEmail('avl-passenger');
    await createAccount(email, passenger.role, true, 'Pat Passenger', {
      name: 'Pat Passenger',
      phone: null,
    });
    await signIn(page, passenger, email);

    await expect(page.getByText(passenger.home)).toBeVisible();
    await expect(goOnline(page)).toHaveCount(0);
    await expect(page.getByText(OFFLINE)).toHaveCount(0);
  });
});
