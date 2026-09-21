import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  PLACES,
  apps,
  createAccount,
  mockPlaces,
  openLogin,
  readDriverAvailability,
  readDriverJourney,
  readVehicleDoc,
  reviewAsAdmin,
  submitLogin,
  uniqueEmail,
} from './helpers';

// Phase 2 acceptance: "Driver can create a valid journey." This drives the whole driver set-up
// through the real screens and the real server functions, with only place search answered by a
// stand-in for Google. Only the account itself (and the staff decisions, made through the same
// functions the admin dashboard will call) are set up outside the driver's own screens.
const [, driver] = apps;
const { office } = PLACES;

const goOnline = (page: Page) => page.getByRole('button', { name: 'Go online', exact: true });
const checklist = (page: Page) => page.getByLabel('Before you can go online');
const tab = (page: Page, name: 'Home' | 'Profile') => page.getByRole('tab', { name }).click();

const vehicleCard = (page: Page) => page.getByLabel('Your vehicle');
const vehicleSeat = (page: Page, count: number) =>
  vehicleCard(page).getByRole('radio', { name: String(count), exact: true });

const destinationCard = (page: Page) => page.getByLabel('Destination', { exact: true });
const startCard = (page: Page) => page.getByLabel('Start of journey', { exact: true });
const seatsCard = (page: Page) => page.getByLabel('Seats on offer', { exact: true });
const detourCard = (page: Page) => page.getByLabel('Maximum detour', { exact: true });

/** A driver who has just registered: verified email, a profile, and nothing else. */
async function newDriver(prefix: string) {
  const email = uniqueEmail(prefix);
  const uid = await createAccount(email, driver.role, true, 'Dan Driver', {
    name: 'Dan Driver',
    phone: '+44 7700 900123',
  });
  return { email, uid };
}

/**
 * Takes a new driver from nothing to online, the way a person would, and checks each step.
 * Leaves the page on the Home tab with the driver online.
 */
async function createJourneyAndGoOnline(page: Page, email: string, uid: string) {
  await mockPlaces(page);
  // The device's position, for the start of the journey (Module 4.1).
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 51.4494, longitude: -2.5813 });
  await openLogin(page, driver.url, driver.title);
  await submitLogin(page, email, PASSWORD);

  // Nothing is set up: the driver cannot go online and is told what is left.
  await expect(page.getByText('You are offline')).toBeVisible();
  await expect(goOnline(page)).toBeDisabled();
  for (const text of [
    'Your driver profile is waiting to be verified.',
    'Add your vehicle in the Profile tab.',
    'Set your destination below.',
    'Save where you are starting below.',
    'Choose how many seats you offer below.',
    'Choose how far you will go out of your way below.',
  ]) {
    await expect(checklist(page).getByText(text)).toBeVisible();
  }

  // The vehicle and its passenger seats.
  await tab(page, 'Profile');
  await page.getByRole('button', { name: 'Add vehicle' }).click();
  await page.getByRole('radio', { name: 'Car' }).click();
  await page.getByLabel('Make', { exact: true }).fill('Toyota');
  await page.getByLabel('Model', { exact: true }).fill('Corolla');
  await page.getByLabel('Plate number').fill(`P2 ${Date.now() % 100000}`);
  await page.getByRole('button', { name: 'Save vehicle' }).click();
  await expect(page.getByText('Your vehicle has been saved.')).toBeVisible();
  await vehicleSeat(page, 4).click();
  await page.getByRole('button', { name: 'Save seats' }).click();
  await expect(page.getByText('Your seats have been saved.')).toBeVisible();
  await expect.poll(() => readVehicleDoc(uid)).toMatchObject({ seatCapacity: 4 });

  // Staff verify the driver and the vehicle. The Home checklist follows without a reload.
  await reviewAsAdmin('driver', uid, 'VERIFIED');
  await reviewAsAdmin('vehicle', uid, 'VERIFIED');
  await tab(page, 'Home');
  await expect(checklist(page).getByText('Driver profile verified')).toBeVisible();
  await expect(checklist(page).getByText('Vehicle verified')).toBeVisible();
  await expect(checklist(page).getByText('Passenger seats set')).toBeVisible();
  await expect(goOnline(page)).toBeDisabled();

  // The journey: where to, how many seats, how far out of the way.
  await destinationCard(page).getByLabel('Search for a destination').fill('canary');
  await destinationCard(page).getByRole('button', { name: office.text }).click();
  await expect(page.getByText('Your destination has been saved.')).toBeVisible();

  await startCard(page)
    .getByRole('button', { name: 'Use my current location as the start' })
    .click();
  await expect(page.getByText('Your start has been saved.')).toBeVisible();
  await expect(goOnline(page)).toBeDisabled();

  await seatsCard(page).getByRole('radio', { name: '3', exact: true }).click();
  await seatsCard(page).getByRole('button', { name: 'Save seats' }).click();
  await expect(page.getByText('Your seats have been saved.')).toBeVisible();
  await expect(goOnline(page)).toBeDisabled();

  await detourCard(page).getByRole('radio', { name: '10 min', exact: true }).click();
  await detourCard(page).getByRole('radio', { name: '5 km', exact: true }).click();
  await detourCard(page).getByRole('button', { name: 'Save detour' }).click();
  await expect(page.getByText('Your detour limits have been saved.')).toBeVisible();

  // Every requirement is met, so the driver can go online.
  await expect(goOnline(page)).toBeEnabled();
  await expect(checklist(page)).toHaveCount(0);
  await goOnline(page).click();
  await expect(page.getByText('You are online')).toBeVisible();
  await expect.poll(() => readDriverAvailability(uid)).toBe('ONLINE');
}

test.describe('phase 2: a driver creates a valid journey', () => {
  test('destination, seats, detour and going online work together, and are stored correctly', async ({
    page,
  }) => {
    const { email, uid } = await newDriver('p2-flow');
    await createJourneyAndGoOnline(page, email, uid);

    const journey = await readDriverJourney(uid);
    expect(journey).toMatchObject({
      driverId: uid,
      status: 'DRAFT',
      address: office.address,
      latitude: office.latitude,
      longitude: office.longitude,
      placeId: office.id,
      availableSeats: 3,
      maxDetourMinutes: 10,
      maxDetourDistance: 5,
      origin: { latitude: 51.4494, longitude: -2.5813, address: 'Current location' },
    });
    // The seats on offer can never be more than the vehicle holds.
    const vehicle = await readVehicleDoc(uid);
    expect(vehicle).toMatchObject({ seatCapacity: 4, verificationStatus: 'VERIFIED' });
    expect(journey?.availableSeats).toBeLessThanOrEqual(vehicle?.seatCapacity ?? 0);

    // Everything is still there after a reload, and the driver is still online.
    await page.reload();
    await expect(page.getByText('You are online')).toBeVisible();
    await expect(destinationCard(page).getByText(office.address)).toBeVisible();
    await expect(seatsCard(page).getByRole('radio', { name: '3', exact: true })).toBeChecked();
    await expect(
      detourCard(page).getByRole('radio', { name: '10 min', exact: true }),
    ).toBeChecked();
    await expect(detourCard(page).getByRole('radio', { name: '5 km', exact: true })).toBeChecked();
    // (The position shared while online, Module 4.1, arrives after the first read: it is not part
    // of the journey being compared.)
    const withoutPosition = (value: typeof journey) => ({ ...value, currentLocation: null });
    expect(withoutPosition(await readDriverJourney(uid))).toEqual(withoutPosition(journey));
  });

  test('the vehicle and the journey keep each other consistent', async ({ page }) => {
    const { email, uid } = await newDriver('p2-consistent');
    await createJourneyAndGoOnline(page, email, uid);

    // A vehicle with fewer seats lowers the seats on offer; it needs no new review, so the driver
    // stays online.
    await tab(page, 'Profile');
    await vehicleSeat(page, 2).click();
    await page.getByRole('button', { name: 'Save seats' }).click();
    await expect(page.getByText('Your seats have been saved.')).toBeVisible();
    await expect.poll(() => readDriverJourney(uid)).toMatchObject({ availableSeats: 2 });
    expect(await readDriverAvailability(uid)).toBe('ONLINE');

    // More seats than were reviewed need a new review, which takes the driver offline. Nothing
    // else about the journey is lost.
    await vehicleSeat(page, 4).click();
    await page.getByRole('button', { name: 'Save seats' }).click();
    await expect(page.getByText('Your seats have been saved.')).toBeVisible();
    await expect.poll(() => readDriverAvailability(uid)).toBe('OFFLINE');
    expect(await readVehicleDoc(uid)).toMatchObject({
      seatCapacity: 4,
      verificationStatus: 'PENDING',
    });
    expect(await readDriverJourney(uid)).toMatchObject({
      availableSeats: 2,
      maxDetourMinutes: 10,
      maxDetourDistance: 5,
      address: office.address,
    });

    await tab(page, 'Home');
    await expect(page.getByText('You are offline')).toBeVisible();
    await expect(goOnline(page)).toBeDisabled();
    await expect(checklist(page).getByText('Your vehicle needs to be verified.')).toBeVisible();

    // Once staff verify the vehicle again the driver can go straight back online.
    await reviewAsAdmin('vehicle', uid, 'VERIFIED');
    await expect(goOnline(page)).toBeEnabled();
    await goOnline(page).click();
    await expect(page.getByText('You are online')).toBeVisible();
    await expect.poll(() => readDriverAvailability(uid)).toBe('ONLINE');
  });
});
