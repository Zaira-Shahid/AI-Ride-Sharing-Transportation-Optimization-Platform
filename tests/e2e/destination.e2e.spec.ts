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

const [passenger, driver] = apps;
const { office, station } = PLACES;

async function signIn(page: Page, app: (typeof apps)[number], email: string) {
  await openLogin(page, app.url, app.title);
  await submitLogin(page, email, PASSWORD);
}

interface Setup {
  /** Whether the driver has a vehicle. Defaults to true. */
  vehicle?: boolean;
  /** Whether the driver already has a destination. Defaults to false. */
  destination?: boolean;
  /** Verified driver and vehicle with seats, so only the destination stands in the way. */
  ready?: boolean;
}

async function newDriver(prefix: string, setup: Setup = {}) {
  const email = uniqueEmail(prefix);
  const uid = await createAccount(email, driver.role, true, 'Dan Driver', {
    name: 'Dan Driver',
    phone: '+44 7700 900123',
  });
  const status = setup.ready ? 'VERIFIED' : 'PENDING';
  if (setup.destination) await writeJourneyDoc(uid);
  await writeDriverDoc(uid, {
    verificationStatus: status,
    currentJourneyId: setup.destination ? journeyId(uid) : null,
  });
  if (setup.vehicle !== false) {
    await writeVehicleDoc(uid, {
      verificationStatus: status,
      seatCapacity: setup.ready ? 4 : null,
    });
  }
  return { email, uid };
}

const card = (page: Page) => page.getByLabel('Destination', { exact: true });
const search = (page: Page) => page.getByLabel('Search for a destination');
const suggestion = (page: Page, text: string) => card(page).getByRole('button', { name: text });
const goOnline = (page: Page) => page.getByRole('button', { name: 'Go online', exact: true });
const checklist = (page: Page) => page.getByLabel('Before you can go online');

test.describe('driver app: destination', () => {
  test('searches Google Places, saves the place picked, and shows it', async ({ page }) => {
    const places = await mockPlaces(page);
    const { email, uid } = await newDriver('dst-pick');
    await signIn(page, driver, email);

    await expect(card(page).getByText('Heading to')).toHaveCount(0);
    await search(page).fill('canary');
    await expect(suggestion(page, office.text)).toBeVisible();
    await expect(card(page).getByText('Canary Wharf', { exact: true })).toBeVisible();
    await expect(card(page).getByText('London, UK', { exact: true })).toBeVisible();
    await expect(card(page).getByText('Powered by Google')).toBeVisible();

    await suggestion(page, office.text).click();

    await expect(page.getByText('Your destination has been saved.')).toBeVisible();
    await expect(card(page).getByText('Heading to')).toBeVisible();
    await expect(card(page).getByText(office.address)).toBeVisible();
    await expect(search(page)).toHaveCount(0);
    await expect
      .poll(() => readDriverJourney(uid))
      .toMatchObject({
        driverId: uid,
        status: 'DRAFT',
        address: office.address,
        latitude: office.latitude,
        longitude: office.longitude,
        placeId: office.id,
      });

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

    await page.reload();
    await expect(card(page).getByText(office.address)).toBeVisible();
  });

  test('changes the destination, keeping the same journey, and cancelling changes nothing', async ({
    page,
  }) => {
    await mockPlaces(page);
    const { email, uid } = await newDriver('dst-change', { destination: true });
    await signIn(page, driver, email);
    await expect(card(page).getByText(office.address)).toBeVisible();
    await expect(search(page)).toHaveCount(0);

    await card(page).getByRole('button', { name: 'Change destination' }).click();
    await search(page).fill('temple');
    await expect(suggestion(page, station.text)).toBeVisible();
    await card(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(search(page)).toHaveCount(0);
    await expect(card(page).getByText(office.address)).toBeVisible();
    expect(await readDriverJourney(uid)).toMatchObject({ address: office.address });

    await card(page).getByRole('button', { name: 'Change destination' }).click();
    await search(page).fill('temple');
    await suggestion(page, station.text).click();

    await expect(card(page).getByText(station.address)).toBeVisible();
    await expect(card(page).getByText(office.address)).toHaveCount(0);
    await expect
      .poll(() => readDriverJourney(uid))
      .toMatchObject({ id: journeyId(uid), address: station.address, placeId: station.id });
  });

  test('is needed to go online: the list asks for it, and going online works once it is set', async ({
    page,
  }) => {
    await mockPlaces(page);
    const { email, uid } = await newDriver('dst-online', { ready: true });
    await signIn(page, driver, email);

    await expect(page.getByText('You are offline')).toBeVisible();
    await expect(goOnline(page)).toBeDisabled();
    await expect(checklist(page).getByText('Set your destination below.')).toBeVisible();
    await expect(checklist(page).getByText('Driver profile verified')).toBeVisible();

    await search(page).fill('canary');
    await suggestion(page, office.text).click();

    // The destination is not the last thing: seats on offer and the detour still have to be chosen.
    await expect(checklist(page).getByText('Destination set')).toBeVisible();
    await expect(goOnline(page)).toBeDisabled();
    await page.getByRole('radio', { name: '2', exact: true }).click();
    await page.getByRole('button', { name: 'Save seats' }).click();
    await page.getByRole('radio', { name: '10 min', exact: true }).click();
    await page.getByRole('radio', { name: '5 km', exact: true }).click();
    await page.getByRole('button', { name: 'Save detour' }).click();

    await expect(goOnline(page)).toBeEnabled();
    await expect(checklist(page)).toHaveCount(0);
    await goOnline(page).click();
    await expect(page.getByText('You are online')).toBeVisible();
    await expect.poll(() => readDriverAvailability(uid)).toBe('ONLINE');

    // Still possible while online, and the driver stays online.
    await card(page).getByRole('button', { name: 'Change destination' }).click();
    await search(page).fill('temple');
    await suggestion(page, station.text).click();
    await expect(card(page).getByText(station.address)).toBeVisible();
    await expect(page.getByText('You are online')).toBeVisible();
  });

  test('waits for two characters, and asks Google once after the person stops typing', async ({
    page,
  }) => {
    const places = await mockPlaces(page);
    const { email } = await newDriver('dst-typing');
    await signIn(page, driver, email);

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
    const { email } = await newDriver('dst-errors');
    await signIn(page, driver, email);

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
    const { email } = await newDriver('dst-refused');
    await signIn(page, driver, email);

    places.failWith(403);
    await search(page).fill('canary');
    await expect(
      card(page).getByText('Place search is not available right now. Please try again later.'),
    ).toBeVisible();
    await expect(page.getByText('e2e-places-key')).toHaveCount(0);
  });

  test('keeps the old destination and says so when saving the picked place fails', async ({
    page,
  }) => {
    const places = await mockPlaces(page);
    const { email, uid } = await newDriver('dst-save-fails', { destination: true });
    await signIn(page, driver, email);

    await card(page).getByRole('button', { name: 'Change destination' }).click();
    await search(page).fill('temple');
    await expect(suggestion(page, station.text)).toBeVisible();
    places.failWith(500);
    await suggestion(page, station.text).click();

    await expect(
      card(page).getByText('We could not search places. Check your connection and try again.'),
    ).toBeVisible();
    expect(await readDriverJourney(uid)).toMatchObject({ address: office.address });
  });

  test('needs a vehicle first', async ({ page }) => {
    await mockPlaces(page);
    const { email, uid } = await newDriver('dst-novehicle', { vehicle: false });
    await signIn(page, driver, email);

    await expect(
      card(page).getByText('Add your vehicle in the Profile tab before you set a destination.'),
    ).toBeVisible();
    await expect(search(page)).toHaveCount(0);
    expect(await readDriverJourney(uid)).toBeUndefined();
  });
});

test.describe('passenger app: destination', () => {
  test('has no driver destination card', async ({ page }) => {
    await mockPlaces(page);
    const email = uniqueEmail('dst-passenger');
    await createAccount(email, passenger.role, true, 'Pat Passenger', {
      name: 'Pat Passenger',
      phone: null,
    });
    await signIn(page, passenger, email);

    await expect(page.getByText(passenger.home)).toBeVisible();
    // The passenger searches for a place too, but on their own Home, not in the driver's card.
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Change destination' })).toHaveCount(0);
  });
});
