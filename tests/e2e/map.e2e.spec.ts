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

const [passenger, driver] = apps;
const { office, station } = PLACES;

// A one-pixel PNG, so the map has a tile to draw without reaching OpenStreetMap.
const TILE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

interface Watch {
  tiles: string[];
  otherMapServers: string[];
  serverCalls: string[];
}

/** Answers OpenStreetMap's tile requests itself, and records who the page talks to. */
async function watchMap(page: Page): Promise<Watch> {
  const watch: Watch = { tiles: [], otherMapServers: [], serverCalls: [] };
  await page.route('https://tile.openstreetmap.org/**', (route) => {
    watch.tiles.push(route.request().url());
    return route.fulfill({ contentType: 'image/png', body: TILE_PNG });
  });
  page.on('request', (request) => {
    const url = request.url();
    if (/maps\.googleapis\.com|maps\.gstatic\.com|mt\d?\.google\.com/.test(url)) {
      watch.otherMapServers.push(url);
    }
    if (url.includes(':5001/')) watch.serverCalls.push(url);
  });
  return watch;
}

/** Counts how often the page asks the browser for its location. */
async function countLocationRequests(page: Page) {
  // Written as text because it runs in the browser, and these tests are not typed for the DOM.
  await page.addInitScript(`
    (() => {
      const geolocation = navigator.geolocation;
      const original = geolocation.getCurrentPosition.bind(geolocation);
      window.__locationRequests = 0;
      geolocation.getCurrentPosition = (...args) => {
        window.__locationRequests += 1;
        return original(...args);
      };
    })();
  `);
  return () => page.evaluate<number>('window.__locationRequests');
}

async function newPassenger(page: Page, prefix: string) {
  const email = uniqueEmail(prefix);
  await createAccount(email, passenger.role, true, 'Pat Passenger', {
    name: 'Pat Passenger',
    phone: null,
  });
  await openLogin(page, passenger.url, passenger.title);
  await submitLogin(page, email, PASSWORD);
  await expect(page.getByRole('heading', { name: 'Where are you going?' })).toBeVisible();
}

const map = (page: Page) => page.getByRole('region', { name: 'Map' });
const destinationMarker = (page: Page) => map(page).getByTitle('Destination');
const locationMarker = (page: Page) => map(page).getByTitle('Your location');
const search = (page: Page) => page.getByLabel('Search for a destination');
const suggestion = (page: Page, text: string) =>
  page.getByLabel('Where to', { exact: true }).getByRole('button', { name: text });
const locate = (page: Page, label = 'Show my location') =>
  page.getByRole('button', { name: label, exact: true });

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return false;
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

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
    // The zoom buttons are not hidden behind the search or the location button: their boxes do
    // not overlap the two cards drawn over the map.
    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    const zoomOut = page.getByRole('button', { name: 'Zoom out' });
    const cards = [
      page.getByLabel('Where to', { exact: true }),
      page.getByLabel('Your location', { exact: true }),
    ];
    for (const control of [zoomIn, zoomOut]) {
      await expect(control).toBeVisible();
      const controlBox = await control.boundingBox();
      expect(controlBox).not.toBeNull();
      for (const card of cards) {
        const cardBox = await card.boundingBox();
        expect(cardBox).not.toBeNull();
        expect(overlaps(controlBox, cardBox)).toBe(false);
      }
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
