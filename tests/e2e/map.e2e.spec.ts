import { expect, test, type Page } from '@playwright/test';
import {
  PLACES,
  apps,
  createAccount,
  mockPlaces,
  openLogin,
  submitLogin,
  uniqueEmail,
  PASSWORD,
} from './helpers';
import { countLocationRequests, newPassenger, watchMap } from './map-helpers';

const [, driver] = apps;
const { office, station } = PLACES;

const map = (page: Page) => page.getByRole('region', { name: 'Map' });
const destinationMarker = (page: Page) => map(page).getByTitle('Destination');
const locationMarker = (page: Page) => map(page).getByTitle('Your location');
const search = (page: Page) => page.getByLabel('Search for a destination');
const suggestion = (page: Page, text: string) =>
  page.getByLabel('Where to', { exact: true }).getByRole('button', { name: text });
const locate = (page: Page, label = 'Show my location') =>
  page.getByRole('button', { name: label, exact: true });

/** A Bristol position, for the device's location. */
const BRISTOL = { latitude: station.latitude, longitude: station.longitude };

test.describe('passenger app: map', () => {
  test('shows a map on OpenStreetMap tiles, with its attribution and zoom controls', async ({
    page,
  }) => {
    const watch = await watchMap(page);
    await newPassenger(page, 'map-show');

    await expect(map(page)).toBeVisible();
    await expect(page.getByRole('link', { name: 'OpenStreetMap' })).toBeVisible();
    // The zoom buttons are not hidden behind the cards drawn over the map: at the middle of each,
    // the button itself is the topmost thing (a hit test, so cards that are scrolled out of sight,
    // or clipped, do not count). The check is written as text because it runs in the browser.
    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    for (const control of [zoomIn, page.getByRole('button', { name: 'Zoom out' })]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
      const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;
      const isTopmost = await page.evaluate<boolean>(
        `(() => { const top = document.elementFromPoint(${x}, ${y}); return top !== null && top.closest('.leaflet-control-zoom') !== null; })()`,
      );
      expect(isTopmost).toBe(true);
    }
    await expect.poll(() => watch.tiles.length).toBeGreaterThan(0);
    for (const url of watch.tiles) {
      expect(url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
    }
    // Zooming in asks for the closer tiles.
    expect(watch.tiles.some((url) => url.includes('/3/'))).toBe(false);
    await zoomIn.click();
    await expect.poll(() => watch.tiles.some((url) => url.includes('/3/'))).toBe(true);

    // Nothing is marked yet, and Google's map servers are never used.
    await expect(destinationMarker(page)).toHaveCount(0);
    await expect(locationMarker(page)).toHaveCount(0);
    expect(watch.otherMapServers).toEqual([]);
  });

  test('marks the destination picked, and closes in on it', async ({ page }) => {
    await mockPlaces(page);
    const watch = await watchMap(page);
    await newPassenger(page, 'map-destination');

    await search(page).fill('canary');
    await suggestion(page, office.text).click();

    await expect(destinationMarker(page)).toBeVisible();
    // Street level: tiles are asked for at zoom 15.
    await expect.poll(() => watch.tiles.some((url) => url.includes('/15/'))).toBe(true);

    await page.getByRole('button', { name: 'Change destination' }).click();
    await expect(destinationMarker(page)).toHaveCount(0);
  });

  test('shows where the passenger is only when they ask, once per tap', async ({ page }) => {
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation(BRISTOL);
    const requests = await countLocationRequests(page);
    await watchMap(page);
    await newPassenger(page, 'map-locate');

    // Signing in and looking at the map never asks the browser for the location.
    await expect(map(page)).toBeVisible();
    expect(await requests()).toBe(0);
    await expect(locationMarker(page)).toHaveCount(0);

    await locate(page).click();
    await expect(locationMarker(page)).toBeVisible();
    await expect(locate(page, 'Update my location')).toBeVisible();
    expect(await requests()).toBe(1);

    await locate(page, 'Update my location').click();
    await expect.poll(requests).toBe(2);
  });

  test('shows both the destination and the passenger, and frames them together', async ({
    page,
  }) => {
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation(BRISTOL);
    await mockPlaces(page);
    const watch = await watchMap(page);
    await newPassenger(page, 'map-both');

    await search(page).fill('canary');
    await suggestion(page, office.text).click();
    await locate(page).click();

    await expect(destinationMarker(page)).toBeVisible();
    await expect(locationMarker(page)).toBeVisible();
    // London and Bristol are about 170 km apart, so the map pulls back from street level.
    const zooms = watch.tiles.map((url) => Number(url.split('/')[3]));
    expect(Math.min(...zooms.slice(-8))).toBeLessThan(12);
  });

  test('says so when location is refused, and shows no location', async ({ page }) => {
    await watchMap(page);
    await newPassenger(page, 'map-denied');

    await locate(page).click();

    await expect(
      page.getByText(
        'Location is turned off for this app. You can turn it on in your browser or phone settings.',
      ),
    ).toBeVisible();
    await expect(locationMarker(page)).toHaveCount(0);
    await expect(locate(page)).toBeEnabled();
  });

  test('keeps the place and the location in the app, sending nothing to the server', async ({
    page,
  }) => {
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation(BRISTOL);
    await mockPlaces(page);
    const watch = await watchMap(page);
    await newPassenger(page, 'map-private');
    watch.serverCalls.length = 0;

    await search(page).fill('canary');
    await suggestion(page, office.text).click();
    await locate(page).click();
    await expect(locationMarker(page)).toBeVisible();

    expect(watch.serverCalls).toEqual([]);
    await page.reload();
    await expect(map(page)).toBeVisible();
    await expect(destinationMarker(page)).toHaveCount(0);
    await expect(locationMarker(page)).toHaveCount(0);
  });
});

test.describe('driver app: map', () => {
  test('has no passenger map', async ({ page }) => {
    await watchMap(page);
    const email = uniqueEmail('map-driver');
    await createAccount(email, driver.role, true, 'Dan Driver', {
      name: 'Dan Driver',
      phone: '+44 7700 900123',
    });
    await openLogin(page, driver.url, driver.title);
    await submitLogin(page, email, PASSWORD);

    await expect(page.getByText(driver.home)).toBeVisible();
    await expect(map(page)).toHaveCount(0);
  });
});
