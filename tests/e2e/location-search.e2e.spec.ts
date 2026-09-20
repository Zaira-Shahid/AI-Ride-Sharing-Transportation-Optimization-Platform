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

const [passenger] = apps;
const { office, station } = PLACES;

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

const card = (page: Page) => page.getByLabel('Where to', { exact: true });
const search = (page: Page) => page.getByLabel('Search for a destination');
const suggestion = (page: Page, text: string) => card(page).getByRole('button', { name: text });

test.describe('passenger app: location search', () => {
  test('searches Google Places, shows the place picked, and sends nothing to the server', async ({
    page,
  }) => {
    const places = await mockPlaces(page);
    await newPassenger(page, 'loc-pick');
    const serverCalls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes(':5001/')) serverCalls.push(request.url());
    });

    await expect(card(page).getByText('Heading to')).toHaveCount(0);
    await search(page).fill('canary');
    await expect(suggestion(page, office.text)).toBeVisible();
    await expect(card(page).getByText('Canary Wharf', { exact: true })).toBeVisible();
    await expect(card(page).getByText('London, UK', { exact: true })).toBeVisible();
    await expect(card(page).getByText('Powered by Google')).toBeVisible();

    await suggestion(page, office.text).click();

    await expect(card(page).getByText('Heading to')).toBeVisible();
    await expect(card(page).getByText(office.address)).toBeVisible();
    await expect(search(page)).toHaveCount(0);

    // The requests Google is sent: the key in a header, only the fields needed, one session.
    const autocomplete = places.calls.filter((call) => call.kind === 'autocomplete');
    const details = places.calls.filter((call) => call.kind === 'details');
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      apiKey: 'e2e-places-key',
      fieldMask: 'id,formattedAddress,location',
      placeId: office.id,
    });
    expect(autocomplete.length).toBeGreaterThan(0);
    for (const call of autocomplete) {
      expect(call.apiKey).toBe('e2e-places-key');
      expect(call.sessionToken).toBe(details[0]?.sessionToken);
    }

    // Nothing was saved anywhere: no server function was called, and the pick is gone after a
    // reload (it is only held in the app until the trip request is submitted).
    expect(serverCalls).toEqual([]);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Where are you going?' })).toBeVisible();
    await expect(card(page).getByText('Heading to')).toHaveCount(0);
    await expect(search(page)).toBeVisible();
  });

  test('changes the place picked', async ({ page }) => {
    await mockPlaces(page);
    await newPassenger(page, 'loc-change');
    await search(page).fill('canary');
    await suggestion(page, office.text).click();
    await expect(card(page).getByText(office.address)).toBeVisible();

    await card(page).getByRole('button', { name: 'Change destination' }).click();
    await expect(card(page).getByText(office.address)).toHaveCount(0);
    await search(page).fill('temple');
    await suggestion(page, station.text).click();

    await expect(card(page).getByText(station.address)).toBeVisible();
    await expect(card(page).getByText(office.address)).toHaveCount(0);
  });

  test('waits for two characters, and asks Google once after the person stops typing', async ({
    page,
  }) => {
    const places = await mockPlaces(page);
    await newPassenger(page, 'loc-typing');

    await search(page).fill('c');
    await page.waitForTimeout(800);
    expect(places.calls).toHaveLength(0);

    await search(page).clear();
    await search(page).pressSequentially('canary', { delay: 40 });
    await expect(suggestion(page, office.text)).toBeVisible();
    expect(places.calls.filter((call) => call.kind === 'autocomplete')).toHaveLength(1);
    expect(places.calls[0]?.input).toBe('canary');
  });

  test('says so when nothing matches, and recovers from a failed search', async ({ page }) => {
    const places = await mockPlaces(page);
    await newPassenger(page, 'loc-errors');

    await search(page).fill('zzzzzz');
    await expect(
      card(page).getByText('No places found. Try a different name or address.'),
    ).toBeVisible();

    places.failWith(503);
    await search(page).fill('canary');
    await expect(
      card(page).getByText('We could not search places. Check your connection and try again.'),
    ).toBeVisible();
    await expect(suggestion(page, office.text)).toHaveCount(0);

    places.failWith(undefined);
    await search(page).fill('canary wharf');
    await expect(suggestion(page, office.text)).toBeVisible();
    await expect(card(page).getByText(/^We could not search places/)).toHaveCount(0);
  });

  test('shows a friendly message when Google refuses the key, never the key itself', async ({
    page,
  }) => {
    const places = await mockPlaces(page);
    await newPassenger(page, 'loc-refused');

    places.failWith(403);
    await search(page).fill('canary');
    await expect(
      card(page).getByText('Place search is not available right now. Please try again later.'),
    ).toBeVisible();
    await expect(page.getByText('e2e-places-key')).toHaveCount(0);
  });

  test('keeps searching, and says so, when the details of the picked place cannot be fetched', async ({
    page,
  }) => {
    const places = await mockPlaces(page);
    await newPassenger(page, 'loc-details-fail');

    await search(page).fill('temple');
    await expect(suggestion(page, station.text)).toBeVisible();
    places.failWith(500);
    await suggestion(page, station.text).click();

    await expect(
      card(page).getByText('We could not search places. Check your connection and try again.'),
    ).toBeVisible();
    await expect(card(page).getByText('Heading to')).toHaveCount(0);
    await expect(search(page)).toBeVisible();

    places.failWith(undefined);
    await search(page).fill('temple meads');
    await suggestion(page, station.text).click();
    await expect(card(page).getByText(station.address)).toBeVisible();
  });
});

test.describe('driver app: location search', () => {
  test('has no passenger Home search', async ({ page }) => {
    await mockPlaces(page);
    const email = uniqueEmail('loc-driver');
    await createAccount(email, 'DRIVER', true, 'Dan Driver', {
      name: 'Dan Driver',
      phone: '+44 7700 900123',
    });
    await openLogin(page, apps[1].url, apps[1].title);
    await submitLogin(page, email, PASSWORD);

    await expect(page.getByText(apps[1].home)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Where are you going?' })).toHaveCount(0);
    await expect(card(page)).toHaveCount(0);
  });
});
