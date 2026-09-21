import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  PLACES,
  apps,
  createAccount,
  journeyId,
  mockPlaces,
  openLogin,
  readDriverAvailability,
  readDriverJourney,
  submitLogin,
  uniqueEmail,
  writeDriverDoc,
  writeJourneyDoc,
  writeVehicleDoc,
} from './helpers';
import { newPassenger, watchMap } from './map-helpers';
import {
  chooseDestination,
  confirm,
  pickupCard,
  requestRide,
  requestedCard,
  reviewCard,
  tripsOf,
} from './trip-helpers';

// Module 4.2. A position from the device gets an address, found by the server (reverse geocoding on
// a position rounded to about 11 m) and never required: when there is none, or the lookup fails, the
// place is still called "Current location" and everything works as before. The geocoder is a fake
// that answers by position (E2E_GEOCODING in tests/fake-nominatim.ts, started by global-setup.ts), so
// nothing reaches OpenStreetMap.

const [, driver] = apps;
const { office } = PLACES;
const ADDRESS = '12 Test Street, Bristol, BS1 6QS';

// Positions near the ones the fake looks for, but not the round numbers themselves, so that what is
// stored is seen to be the exact reading and not the rounded one that was looked up.
type Where = { latitude: number; longitude: number };
const FOUND: Where = { latitude: 40.00004, longitude: 10.00003 };
const FAILING: Where = { latitude: 41.00004, longitude: 10.00003 };
const NO_ADDRESS: Where = { latitude: 42.00004, longitude: 10.00003 };

/** The cases where no address comes back: the app carries on with "Current location". */
const WITHOUT_ADDRESS: [string, Where][] = [
  ['there is no address for the position', NO_ADDRESS],
  ['the lookup fails', FAILING],
];

async function allowLocation(page: Page, where: Where) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation(where);
}

async function newDriver(prefix: string) {
  const email = uniqueEmail(prefix);
  const uid = await createAccount(email, driver.role, true, 'Dan Driver', {
    name: 'Dan Driver',
    phone: '+44 7700 900123',
  });
  await writeJourneyDoc(uid, office, 3, { minutes: 10, km: 5 }, null);
  await writeDriverDoc(uid, { verificationStatus: 'VERIFIED', currentJourneyId: journeyId(uid) });
  await writeVehicleDoc(uid, { verificationStatus: 'VERIFIED', seatCapacity: 4 });
  return { email, uid };
}

const startCard = (page: Page) => page.getByLabel('Start of journey', { exact: true });
const saveStart = (page: Page) =>
  startCard(page).getByRole('button', { name: 'Use my current location as the start' });
const useMyLocation = (page: Page) =>
  page.getByRole('button', { name: 'Use my current location', exact: true });

test.describe('driver app: the address of the start', () => {
  test('saves the start with the address found for it, and the exact position', async ({
    page,
  }) => {
    await allowLocation(page, FOUND);
    const { email, uid } = await newDriver('geo-drv-found');
    await openLogin(page, driver.url, driver.title);
    await submitLogin(page, email, PASSWORD);

    await saveStart(page).click();

    await expect(startCard(page).getByText('Your start has been saved.')).toBeVisible();
    await expect(startCard(page).getByText(ADDRESS, { exact: true })).toBeVisible();
    await expect(startCard(page).getByText('Current location', { exact: true })).toHaveCount(0);
    const origin = (await readDriverJourney(uid))?.origin;
    expect(origin?.address).toBe(ADDRESS);
    // The address came from the rounded position, but what is stored is where the device was.
    expect(origin?.latitude).toBeCloseTo(FOUND.latitude, 6);
    expect(origin?.longitude).toBeCloseTo(FOUND.longitude, 6);
  });

  for (const [reason, where] of WITHOUT_ADDRESS) {
    test(`saves the start as "Current location" when ${reason}, and the driver can go online`, async ({
      page,
    }) => {
      await allowLocation(page, where);
      const { email, uid } = await newDriver('geo-drv-none');
      await openLogin(page, driver.url, driver.title);
      await submitLogin(page, email, PASSWORD);

      await saveStart(page).click();

      await expect(startCard(page).getByText('Your start has been saved.')).toBeVisible();
      await expect(startCard(page).getByText('Current location', { exact: true })).toBeVisible();
      await expect(startCard(page).getByRole('alert')).toHaveCount(0);
      const origin = (await readDriverJourney(uid))?.origin;
      expect(origin?.address).toBe('Current location');
      expect(origin?.latitude).toBeCloseTo(where.latitude, 6);

      // The address was never required: everything else works.
      const goOnline = page.getByRole('button', { name: 'Go online', exact: true });
      await expect(goOnline).toBeEnabled();
      await goOnline.click();
      await expect(page.getByText('You are online')).toBeVisible();
      await expect.poll(() => readDriverAvailability(uid)).toBe('ONLINE');
    });
  }
});

test.describe('passenger app: the address of a pickup from the device', () => {
  async function startPassenger(page: Page, prefix: string, where: Where) {
    await allowLocation(page, where);
    await mockPlaces(page);
    await watchMap(page);
    const { uid } = await newPassenger(page, prefix);
    await chooseDestination(page, 'canary', office.text);
    return uid;
  }

  test('shows the address found for the position, and asks for a ride from the exact position', async ({
    page,
  }) => {
    const uid = await startPassenger(page, 'geo-pax-found', FOUND);
    const lookup = page.waitForRequest(
      (request) => request.url().includes('reverseGeocode') && request.method() === 'POST',
    );

    await useMyLocation(page).click();

    // The app rounds the position (about 11 m) before it leaves the device: the exact one is never sent.
    expect((await lookup).postDataJSON()).toEqual({ data: { latitude: 40, longitude: 10 } });

    await expect(pickupCard(page).getByText('Picking up at')).toBeVisible();
    await expect(pickupCard(page).getByText(ADDRESS, { exact: true })).toBeVisible();
    await expect(pickupCard(page).getByText('Current location', { exact: true })).toHaveCount(0);

    await requestRide(page).click();
    await expect(reviewCard(page).getByText(ADDRESS, { exact: true })).toBeVisible();
    await confirm(page).click();
    await expect(requestedCard(page).getByText(ADDRESS, { exact: true })).toBeVisible();

    const [trip] = await tripsOf(uid);
    const origin = (
      trip?.fields as unknown as Record<
        string,
        { mapValue?: { fields: Record<string, { stringValue?: string; doubleValue?: number }> } }
      >
    ).origin?.mapValue?.fields;
    expect(origin?.formattedAddress?.stringValue).toBe(ADDRESS);
    expect(origin?.placeId).toEqual({ nullValue: null });
    // What is stored is where the device was, not the rounded position used to find the address.
    expect(origin?.latitude?.doubleValue).toBeCloseTo(FOUND.latitude, 6);
    expect(origin?.longitude?.doubleValue).toBeCloseTo(FOUND.longitude, 6);
  });

  for (const [reason, where] of WITHOUT_ADDRESS) {
    test(`keeps "Current location" when ${reason}, and a ride can still be requested`, async ({
      page,
    }) => {
      const uid = await startPassenger(page, 'geo-pax-none', where);

      await useMyLocation(page).click();

      await expect(pickupCard(page).getByText('Picking up at')).toBeVisible();
      await expect(pickupCard(page).getByText('Current location', { exact: true })).toBeVisible();
      await expect(pickupCard(page).getByRole('alert')).toHaveCount(0);

      await requestRide(page).click();
      await confirm(page).click();
      await expect(
        requestedCard(page).getByText('Current location', { exact: true }),
      ).toBeVisible();
      expect(await tripsOf(uid)).toHaveLength(1);
    });
  }

  test('does not let a lookup that finishes late replace a pickup the passenger chose meanwhile', async ({
    page,
  }) => {
    await startPassenger(page, 'geo-pax-changed', FOUND);
    // Hold the lookup until the passenger has chosen another pickup, then let it through. (Waiting
    // a fixed time instead would leave it open whether the answer had come back by the time of the
    // check, and a check that cannot fail proves nothing.)
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/reverseGeocode', async (route) => {
      await held;
      await route.continue();
    });

    await useMyLocation(page).click();
    await expect(pickupCard(page).getByText('Finding your pickup')).toBeVisible();
    // The pickup is not chosen yet, so search is what is on offer; pick a place from it.
    await page.getByLabel('Search for a pickup').fill('temple');
    await pickupCard(page).getByRole('button', { name: PLACES.station.text }).click();
    await expect(pickupCard(page).getByText(PLACES.station.address)).toBeVisible();

    const answered = page.waitForResponse(
      (response) =>
        response.url().includes('reverseGeocode') && response.request().method() === 'POST',
    );
    release();
    await answered;
    // Give the app time to act on the answer, if it were going to.
    await page.waitForTimeout(500);

    // The passenger's choice stands, and nothing is left "finding" anything.
    await expect(pickupCard(page).getByText(PLACES.station.address)).toBeVisible();
    await expect(pickupCard(page).getByText(ADDRESS, { exact: true })).toHaveCount(0);
    await expect(pickupCard(page).getByText('Finding your pickup')).toHaveCount(0);
  });
});
