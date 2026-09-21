import { expect, type Page } from '@playwright/test';
import { TEST_PORTS } from '../test-ports';
import { PASSWORD, apps, createAccount, openLogin, submitLogin, uniqueEmail } from './helpers';

const [passenger] = apps;

// A one-pixel PNG, so the map has a tile to draw without reaching OpenStreetMap.
const TILE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export interface Watch {
  tiles: string[];
  otherMapServers: string[];
  serverCalls: string[];
}

/** Answers OpenStreetMap's tile requests itself, and records who the page talks to. */
export async function watchMap(page: Page): Promise<Watch> {
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
    if (url.includes(`:${TEST_PORTS.functions}/`)) watch.serverCalls.push(url);
  });
  return watch;
}

/** Counts how often the page asks the browser for its location. */
export async function countLocationRequests(page: Page) {
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

export async function newPassenger(page: Page, prefix: string) {
  const email = uniqueEmail(prefix);
  const uid = await createAccount(email, passenger.role, true, 'Pat Passenger', {
    name: 'Pat Passenger',
    phone: null,
  });
  await openLogin(page, passenger.url, passenger.title);
  await submitLogin(page, email, PASSWORD);
  await expect(page.getByRole('heading', { name: 'Where are you going?' })).toBeVisible();
  return { uid, email };
}
