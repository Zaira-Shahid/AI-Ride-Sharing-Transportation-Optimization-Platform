import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  PLACES,
  apps,
  createAccount,
  mockPlaces,
  openLogin,
  submitLogin,
  uniqueEmail,
} from './helpers';
import { countLocationRequests, newPassenger, watchMap } from './map-helpers';

const [, driver] = apps;
const { office, station, neighbour, nearby } = PLACES;

const PICKUP_IS_DESTINATION =
  'Your pickup is the same place as your destination. Choose a different pickup.';
const DESTINATION_IS_PICKUP =
  'Your destination is the same place as your pickup. Choose a different destination.';

const map = (page: Page) => page.getByRole('region', { name: 'Map' });
const pickupMarker = (page: Page) => map(page).getByTitle('Pickup', { exact: true });
const destinationMarker = (page: Page) => map(page).getByTitle('Destination', { exact: true });
const locationMarker = (page: Page) => map(page).getByTitle('Your location', { exact: true });

const pickupCard = (page: Page) => page.getByLabel('Pickup', { exact: true });
const destinationCard = (page: Page) => page.getByLabel('Where to', { exact: true });
const searchPickup = (page: Page) => page.getByLabel('Search for a pickup');
const searchDestination = (page: Page) => page.getByLabel('Search for a destination');
const pickupSuggestion = (page: Page, text: string) =>
  pickupCard(page).getByRole('button', { name: text });
const destinationSuggestion = (page: Page, text: string) =>
  destinationCard(page).getByRole('button', { name: text });
const useCurrentLocation = (page: Page) =>
  page.getByRole('button', { name: 'Use my current location', exact: true });

/** Picks a place for the destination, through the search. */
async function chooseDestination(page: Page, query: string, text: string) {
  await searchDestination(page).fill(query);
  await destinationSuggestion(page, text).click();
}

/** Picks a place for the pickup, through the search. */
async function choosePickup(page: Page, query: string, text: string) {
  await searchPickup(page).fill(query);
  await pickupSuggestion(page, text).click();
}

/** Where the device is, for tests that use the current location. */
const BRISTOL = { latitude: station.latitude, longitude: station.longitude };

async function allowLocation(page: Page, where = BRISTOL) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation(where);
}

test.describe('passenger app: pickup', () => {
  test('offers the current location and a search, and asks for nothing at first', async ({
    page,
  }) => {
    await allowLocation(page);
    const requests = await countLocationRequests(page);
    await watchMap(page);
    await newPassenger(page, 'pick-start');

    await expect(pickupCard(page).getByText('Where should we pick you up?')).toBeVisible();
    await expect(useCurrentLocation(page)).toBeEnabled();
    await expect(searchPickup(page)).toBeVisible();
    await expect(pickupCard(page).getByText('Picking up at')).toHaveCount(0);
    await expect(pickupMarker(page)).toHaveCount(0);
    // Not even the pickup's own button asks the browser for the location until it is pressed.
    expect(await requests()).toBe(0);
  });

  test('takes the current location as the pickup, only when asked', async ({ page }) => {
    await allowLocation(page);
    const requests = await countLocationRequests(page);
    await watchMap(page);
    await newPassenger(page, 'pick-here');

    await useCurrentLocation(page).click();

    await expect(pickupCard(page).getByText('Picking up at')).toBeVisible();
    await expect(pickupCard(page).getByText('Current location', { exact: true })).toBeVisible();
    await expect(pickupMarker(page)).toBeVisible();
    await expect(useCurrentLocation(page)).toHaveCount(0);
    expect(await requests()).toBe(1);

    await page.getByRole('button', { name: 'Change pickup' }).click();
    await expect(pickupMarker(page)).toHaveCount(0);
    await expect(useCurrentLocation(page)).toBeVisible();
    await expect(searchPickup(page)).toBeVisible();
  });

  test('searches for a different pickup, and changes it', async ({ page }) => {
    const places = await mockPlaces(page);
    await allowLocation(page);
    const requests = await countLocationRequests(page);
    await watchMap(page);
    await newPassenger(page, 'pick-search');

    await choosePickup(page, 'temple', station.text);

    await expect(pickupCard(page).getByText('Picking up at')).toBeVisible();
    await expect(pickupCard(page).getByText(station.address)).toBeVisible();
    await expect(pickupMarker(page)).toBeVisible();
    // Searching does not use the device's location, and asks Google only for the fields needed.
    expect(await requests()).toBe(0);
    const details = places.calls.filter((call) => call.kind === 'details');
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ fieldMask: 'id,formattedAddress,location' });

    await page.getByRole('button', { name: 'Change pickup' }).click();
    await choosePickup(page, 'canary', office.text);
    await expect(pickupCard(page).getByText(office.address)).toBeVisible();
    await expect(pickupCard(page).getByText(station.address)).toHaveCount(0);
  });

  test('shows the pickup and the destination together on the map', async ({ page }) => {
    await mockPlaces(page);
    await watchMap(page);
    await newPassenger(page, 'pick-both');

    await choosePickup(page, 'temple', station.text);
    await chooseDestination(page, 'canary', office.text);

    await expect(pickupMarker(page)).toBeVisible();
    await expect(destinationMarker(page)).toBeVisible();
    await expect(pickupCard(page).getByText(station.address)).toBeVisible();
    await expect(destinationCard(page).getByText(office.address)).toBeVisible();
  });

  test('refuses a pickup that is the same place as the destination', async ({ page }) => {
    await mockPlaces(page);
    await watchMap(page);
    await newPassenger(page, 'pick-same-id');
    await chooseDestination(page, 'canary', office.text);

    await choosePickup(page, 'canary', office.text);

    await expect(pickupCard(page).getByText(PICKUP_IS_DESTINATION)).toBeVisible();
    await expect(pickupCard(page).getByText('Picking up at')).toHaveCount(0);
    await expect(pickupMarker(page)).toHaveCount(0);
    await expect(searchPickup(page)).toBeVisible();

    // A different place is accepted, and the message goes.
    await searchPickup(page).fill('temple');
    await pickupSuggestion(page, station.text).click();
    await expect(pickupCard(page).getByText(station.address)).toBeVisible();
    await expect(page.getByText(PICKUP_IS_DESTINATION)).toHaveCount(0);
  });

  test('treats places closer than 50 m as the same place, and 89 m as different', async ({
    page,
  }) => {
    await mockPlaces(page);
    await watchMap(page);
    await newPassenger(page, 'pick-close');
    await chooseDestination(page, 'canary', office.text);

    // 22 m away, with a place ID of its own: still the same place for a trip.
    await choosePickup(page, 'reuters', neighbour.text);
    await expect(pickupCard(page).getByText(PICKUP_IS_DESTINATION)).toBeVisible();
    await expect(pickupCard(page).getByText('Picking up at')).toHaveCount(0);

    // 89 m away is a different place.
    await searchPickup(page).fill('cabot');
    await pickupSuggestion(page, nearby.text).click();
    await expect(pickupCard(page).getByText(nearby.address)).toBeVisible();
  });

  test('refuses the current location as the pickup when it is at the destination', async ({
    page,
  }) => {
    // The device is 22 m from the office, so it is the same place for a trip.
    await allowLocation(page, { latitude: neighbour.latitude, longitude: neighbour.longitude });
    await mockPlaces(page);
    await watchMap(page);
    await newPassenger(page, 'pick-here-same');
    await chooseDestination(page, 'canary', office.text);

    await useCurrentLocation(page).click();

    await expect(pickupCard(page).getByText(PICKUP_IS_DESTINATION)).toBeVisible();
    await expect(pickupCard(page).getByText('Picking up at')).toHaveCount(0);
    await expect(pickupMarker(page)).toHaveCount(0);
    await expect(useCurrentLocation(page)).toBeEnabled();
  });

  test('refuses a destination that is the same place as the pickup', async ({ page }) => {
    await mockPlaces(page);
    await watchMap(page);
    await newPassenger(page, 'pick-dest-same');
    await choosePickup(page, 'temple', station.text);

    await chooseDestination(page, 'temple', station.text);

    await expect(destinationCard(page).getByText(DESTINATION_IS_PICKUP)).toBeVisible();
    await expect(destinationCard(page).getByText('Heading to')).toHaveCount(0);
    await expect(destinationMarker(page)).toHaveCount(0);
    await expect(searchDestination(page)).toBeVisible();

    await searchDestination(page).fill('canary');
    await destinationSuggestion(page, office.text).click();
    await expect(destinationCard(page).getByText(office.address)).toBeVisible();
    await expect(page.getByText(DESTINATION_IS_PICKUP)).toHaveCount(0);
  });

  test('says so once when location is refused for the pickup, and the search still works', async ({
    page,
  }) => {
    await mockPlaces(page);
    await watchMap(page);
    await newPassenger(page, 'pick-denied');

    await useCurrentLocation(page).click();

    const problem =
      'Location is turned off for this app. You can turn it on in your browser or phone settings.';
    await expect(pickupCard(page).getByText(problem)).toBeVisible();
    // Shown next to the button that was pressed, not a second time at the bottom.
    await expect(page.getByText(problem)).toHaveCount(1);
    await expect(pickupMarker(page)).toHaveCount(0);

    await choosePickup(page, 'temple', station.text);
    await expect(pickupCard(page).getByText(station.address)).toBeVisible();
  });

  test('keeps the places in the app: the only thing sent is the address lookup for the device position', async ({
    page,
  }) => {
    await allowLocation(page);
    await mockPlaces(page);
    const watch = await watchMap(page);
    await newPassenger(page, 'pick-private');
    watch.serverCalls.length = 0;

    await chooseDestination(page, 'canary', office.text);
    await useCurrentLocation(page).click();
    await expect(pickupMarker(page)).toBeVisible();

    // A pickup from the device asks the server for its address (Module 4.2), and that is all: nothing
    // that creates or stores a request, a place or a position (the request is built only in the app
    // until it is confirmed).
    expect(watch.serverCalls).toHaveLength(1);
    expect(watch.serverCalls[0]).toContain('/reverseGeocode');
    await page.reload();
    await expect(map(page)).toBeVisible();
    await expect(pickupMarker(page)).toHaveCount(0);
    await expect(destinationMarker(page)).toHaveCount(0);
    await expect(locationMarker(page)).toHaveCount(0);
  });
});

test.describe('driver app: pickup', () => {
  test('has no pickup', async ({ page }) => {
    const email = uniqueEmail('pick-driver');
    await createAccount(email, driver.role, true, 'Dan Driver', {
      name: 'Dan Driver',
      phone: '+44 7700 900123',
    });
    await openLogin(page, driver.url, driver.title);
    await submitLogin(page, email, PASSWORD);

    await expect(page.getByText(driver.home)).toBeVisible();
    await expect(pickupCard(page)).toHaveCount(0);
    await expect(useCurrentLocation(page)).toHaveCount(0);
  });
});
