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
import { countLocationRequests, watchMap } from './map-helpers';

const [, driver] = apps;
const { station } = PLACES;

// Module 4.1. The driver saves where the journey starts (one reading, only when they ask), which is
// needed to go online; and while they are online their position is shared with the server, sparingly
// and only then. The browser's location is played by Playwright, which is why these tests can move
// the "device" and see what reaches the database.

const BRISTOL = { latitude: station.latitude, longitude: station.longitude };
// About 5 km from Bristol Temple Meads.
const FISHPONDS = { latitude: 51.4776, longitude: -2.5355 };

async function newDriver(prefix: string, options: { origin: boolean }) {
  const email = uniqueEmail(prefix);
  const uid = await createAccount(email, driver.role, true, 'Dan Driver', {
    name: 'Dan Driver',
    phone: '+44 7700 900123',
  });
  await writeJourneyDoc(
    uid,
    PLACES.office,
    3,
    { minutes: 10, km: 5 },
    options.origin ? undefined : null,
  );
  await writeDriverDoc(uid, { verificationStatus: 'VERIFIED', currentJourneyId: journeyId(uid) });
  await writeVehicleDoc(uid, { verificationStatus: 'VERIFIED', seatCapacity: 4 });
  return { email, uid };
}

async function signIn(page: Page, email: string) {
  await openLogin(page, driver.url, driver.title);
  await submitLogin(page, email, PASSWORD);
}

async function allowLocation(page: Page, where = BRISTOL) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation(where);
}

const goOnline = (page: Page) => page.getByRole('button', { name: 'Go online', exact: true });
const goOffline = (page: Page) => page.getByRole('button', { name: 'Go offline', exact: true });
const startCard = (page: Page) => page.getByLabel('Start of journey', { exact: true });
const saveStart = (page: Page) =>
  startCard(page).getByRole('button', { name: 'Use my current location as the start' });
const sharing = (page: Page) => page.getByText('Sharing your location while online.');

const near = (actual: number | null | undefined, expected: number) =>
  expect(actual ?? Number.NaN).toBeCloseTo(expected, 4);

test.describe('driver app: the start of the journey', () => {
  test('asks nothing until the driver asks, then saves one reading as the start', async ({
    page,
  }) => {
    await allowLocation(page);
    const requests = await countLocationRequests(page);
    const { email, uid } = await newDriver('gps-origin', { origin: false });
    await signIn(page, email);

    // Going online waits for the start, and the card says what it will do.
    await expect(page.getByText('You are offline')).toBeVisible();
    await expect(goOnline(page)).toBeDisabled();
    await expect(
      page.getByLabel('Before you can go online').getByText('Save where you are starting below.'),
    ).toBeVisible();
    await expect(startCard(page).getByText('Not saved yet.', { exact: false })).toBeVisible();
    expect(await requests()).toBe(0);
    expect((await readDriverJourney(uid))?.origin).toBeNull();

    await saveStart(page).click();

    await expect(startCard(page).getByText('Your start has been saved.')).toBeVisible();
    await expect(startCard(page).getByText('Starting from')).toBeVisible();
    await expect(startCard(page).getByText('Current location', { exact: true })).toBeVisible();
    expect(await requests()).toBe(1);
    const origin = (await readDriverJourney(uid))?.origin;
    near(origin?.latitude, BRISTOL.latitude);
    near(origin?.longitude, BRISTOL.longitude);
    expect(origin?.address).toBe('Current location');

    // Now the driver can go online, and the start can be updated with another reading.
    await expect(goOnline(page)).toBeEnabled();
    await page.context().setGeolocation(FISHPONDS);
    await startCard(page).getByRole('button', { name: 'Update my start' }).click();
    await expect
      .poll(async () => (await readDriverJourney(uid))?.origin?.latitude)
      .toBeCloseTo(FISHPONDS.latitude, 4);
  });

  test('says so when location is turned off, and saves nothing', async ({ page }) => {
    const { email, uid } = await newDriver('gps-denied', { origin: false });
    await signIn(page, email);

    await saveStart(page).click();

    await expect(
      startCard(page).getByText(
        'Location is turned off for this app. You can turn it on in your browser or phone settings.',
      ),
    ).toBeVisible();
    await expect(saveStart(page)).toBeEnabled();
    await expect(goOnline(page)).toBeDisabled();
    expect((await readDriverJourney(uid))?.origin).toBeNull();
  });
});

test.describe('driver app: sharing the location while online', () => {
  test('shares the position once online, and stops and clears it when offline', async ({
    page,
  }) => {
    await allowLocation(page);
    const { email, uid } = await newDriver('gps-share', { origin: true });
    await signIn(page, email);
    await expect(goOnline(page)).toBeEnabled();

    // Offline: nothing is followed or sent, however the device moves.
    await page.context().setGeolocation(FISHPONDS);
    await page.waitForTimeout(1500);
    expect((await readDriverJourney(uid))?.currentLocation).toBeNull();

    await page.context().setGeolocation(BRISTOL);
    await goOnline(page).click();
    await expect(sharing(page)).toBeVisible();
    await expect
      .poll(async () => (await readDriverJourney(uid))?.currentLocation?.latitude)
      .toBeCloseTo(BRISTOL.latitude, 4);
    expect((await readDriverJourney(uid))?.currentLocation?.longitude).toBeCloseTo(
      BRISTOL.longitude,
      4,
    );

    // Going offline removes the position, and later movement is not sent.
    await goOffline(page).click();
    await expect(page.getByText('You are offline')).toBeVisible();
    await expect.poll(async () => (await readDriverJourney(uid))?.currentLocation).toBeNull();
    await page.context().setGeolocation(FISHPONDS);
    await page.waitForTimeout(1500);
    expect((await readDriverJourney(uid))?.currentLocation).toBeNull();
    expect(await readDriverAvailability(uid)).toBe('OFFLINE');
  });

  test('sends sparingly: the app itself does not send a second reading seconds after the first', async ({
    page,
  }) => {
    await allowLocation(page);
    // Counts what the app asks the server to do, so that this tests the app's own rule and not the
    // server's safety net, which would refuse a second write in this time as well.
    const watch = await watchMap(page);
    const { email, uid } = await newDriver('gps-sparing', { origin: true });
    await signIn(page, email);
    await goOnline(page).click();
    await expect
      .poll(async () => (await readDriverJourney(uid))?.currentLocation?.latitude)
      .toBeCloseTo(BRISTOL.latitude, 4);
    const sent = () => watch.serverCalls.filter((url) => url.includes('updateDriverLocation'));
    expect(sent()).toHaveLength(1);

    // The app writes at most every 30 seconds, so this move, seconds later, is not even sent.
    await page.context().setGeolocation(FISHPONDS);
    await page.waitForTimeout(4000);

    expect(sent()).toHaveLength(1);
    expect((await readDriverJourney(uid))?.currentLocation?.latitude).toBeCloseTo(
      BRISTOL.latitude,
      4,
    );
  });

  test('says so when location is off, and the driver can still be online', async ({ page }) => {
    const { email, uid } = await newDriver('gps-off', { origin: true });
    await signIn(page, email);

    await goOnline(page).click();

    await expect(page.getByText('You are online')).toBeVisible();
    await expect(
      page.getByText(
        'Your location is not being shared because location is turned off for this app.',
        { exact: false },
      ),
    ).toBeVisible();
    await expect(sharing(page)).toHaveCount(0);
    expect((await readDriverJourney(uid))?.currentLocation).toBeNull();
  });
});
