import { expect, test, type Page } from '@playwright/test';
import { PLACES, firestoreDocs, mockPlaces } from './helpers';
import { newPassenger, watchMap } from './map-helpers';

const { office, station } = PLACES;

const map = (page: Page) => page.getByRole('region', { name: 'Map' });
const pickupMarker = (page: Page) => map(page).getByTitle('Pickup', { exact: true });
const destinationMarker = (page: Page) => map(page).getByTitle('Destination', { exact: true });

const pickupCard = (page: Page) => page.getByLabel('Pickup', { exact: true });
const destinationCard = (page: Page) => page.getByLabel('Where to', { exact: true });
const reviewCard = (page: Page) => page.getByLabel('Review your ride request', { exact: true });
const requestedCard = (page: Page) => page.getByLabel('Ride requested', { exact: true });
const requestRide = (page: Page) => page.getByRole('button', { name: 'Request ride', exact: true });
const confirm = (page: Page) =>
  page.getByRole('button', { name: 'Confirm ride request', exact: true });
const cancelRequest = (page: Page) =>
  page.getByRole('button', { name: 'Cancel ride request', exact: true });

async function chooseDestination(page: Page, query: string, text: string) {
  await page.getByLabel('Search for a destination').fill(query);
  await destinationCard(page).getByRole('button', { name: text }).click();
}

async function choosePickup(page: Page, query: string, text: string) {
  await page.getByLabel('Search for a pickup').fill(query);
  await pickupCard(page).getByRole('button', { name: text }).click();
}

/** A passenger with both places chosen, ready to request a ride. */
async function readyToRequest(page: Page, prefix: string) {
  await mockPlaces(page);
  const watch = await watchMap(page);
  const { uid } = await newPassenger(page, prefix);
  await chooseDestination(page, 'canary', office.text);
  await choosePickup(page, 'temple', station.text);
  return { uid, watch };
}

interface StoredTrip {
  name: string;
  fields: Record<string, { stringValue?: string; nullValue?: null; timestampValue?: string }>;
}

/** The trip requests stored for a passenger, read with the emulator owner token. */
async function tripsOf(uid: string): Promise<StoredTrip[]> {
  const response = await fetch(`${firestoreDocs}/tripRequests?pageSize=300`, {
    headers: { authorization: 'Bearer owner' },
  });
  const { documents = [] } = (await response.json()) as { documents?: StoredTrip[] };
  return documents.filter((trip) => trip.fields.passengerId?.stringValue === uid);
}

const statusOf = (trip: StoredTrip | undefined) => trip?.fields.status?.stringValue;

test.describe('passenger app: requesting a ride', () => {
  test('cannot request a ride until both places are chosen', async ({ page }) => {
    await mockPlaces(page);
    await watchMap(page);
    await newPassenger(page, 'req-disabled');
    await expect(requestRide(page)).toBeDisabled();

    await chooseDestination(page, 'canary', office.text);
    await expect(requestRide(page)).toBeDisabled();

    await choosePickup(page, 'temple', station.text);
    await expect(requestRide(page)).toBeEnabled();
  });

  test('reviews the request first, sends nothing, and goes back to change it', async ({ page }) => {
    const { uid, watch } = await readyToRequest(page, 'req-review');
    watch.serverCalls.length = 0;

    await requestRide(page).click();

    await expect(reviewCard(page)).toBeVisible();
    await expect(reviewCard(page).getByText(station.address)).toBeVisible();
    await expect(reviewCard(page).getByText(office.address)).toBeVisible();
    await expect(reviewCard(page).getByText('Now', { exact: true })).toBeVisible();
    await expect(
      reviewCard(page).getByText('Balanced, sharing the ride', { exact: true }),
    ).toBeVisible();
    // The places are not on show for editing while reviewing, and nothing has gone to the server.
    await expect(destinationCard(page)).toHaveCount(0);
    expect(watch.serverCalls).toEqual([]);
    expect(await tripsOf(uid)).toHaveLength(0);

    await reviewCard(page).getByRole('button', { name: 'Back', exact: true }).click();
    await expect(reviewCard(page)).toHaveCount(0);
    await expect(destinationCard(page).getByText(office.address)).toBeVisible();
    await expect(pickupCard(page).getByText(station.address)).toBeVisible();
    await expect(requestRide(page)).toBeEnabled();
    expect(await tripsOf(uid)).toHaveLength(0);
  });

  test('creates the request once confirmed and shows it, with the places on the map', async ({
    page,
  }) => {
    const { uid } = await readyToRequest(page, 'req-create');
    await requestRide(page).click();

    await confirm(page).click();

    await expect(requestedCard(page)).toBeVisible();
    await expect(requestedCard(page).getByText(station.address)).toBeVisible();
    await expect(requestedCard(page).getByText(office.address)).toBeVisible();
    await expect(pickupMarker(page)).toBeVisible();
    await expect(destinationMarker(page)).toBeVisible();
    // The planning cards and the request button give way to the request.
    await expect(destinationCard(page)).toHaveCount(0);
    await expect(requestRide(page)).toHaveCount(0);

    const trips = await tripsOf(uid);
    expect(trips).toHaveLength(1);
    expect(statusOf(trips[0])).toBe('REQUESTED');
  });

  test('keeps showing the request after the app is reloaded', async ({ page }) => {
    const { uid } = await readyToRequest(page, 'req-reload');
    await requestRide(page).click();
    await confirm(page).click();
    await expect(requestedCard(page)).toBeVisible();

    await page.reload();

    await expect(requestedCard(page)).toBeVisible();
    await expect(requestedCard(page).getByText(office.address)).toBeVisible();
    expect(await tripsOf(uid)).toHaveLength(1);
  });

  test('keeps the request when the passenger changes their mind about cancelling', async ({
    page,
  }) => {
    const { uid } = await readyToRequest(page, 'req-keep');
    await requestRide(page).click();
    await confirm(page).click();
    await expect(requestedCard(page)).toBeVisible();

    await cancelRequest(page).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Keep request', exact: true }).click();

    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(requestedCard(page)).toBeVisible();
    expect(statusOf((await tripsOf(uid))[0])).toBe('REQUESTED');
  });

  test('cancels the request after confirming, and returns to planning with the choices kept', async ({
    page,
  }) => {
    const { uid } = await readyToRequest(page, 'req-cancel');
    await requestRide(page).click();
    await confirm(page).click();
    await expect(requestedCard(page)).toBeVisible();

    await cancelRequest(page).click();
    await page.getByRole('button', { name: 'Yes, cancel it', exact: true }).click();

    await expect(requestedCard(page)).toHaveCount(0);
    await expect(destinationCard(page).getByText(office.address)).toBeVisible();
    await expect(pickupCard(page).getByText(station.address)).toBeVisible();
    await expect(requestRide(page)).toBeEnabled();
    expect(statusOf((await tripsOf(uid))[0])).toBe('CANCELLED');

    // A new request can be made straight away.
    await requestRide(page).click();
    await confirm(page).click();
    await expect(requestedCard(page)).toBeVisible();
    expect(await tripsOf(uid)).toHaveLength(2);
  });

  test('does not offer to cancel a request that is past waiting', async ({ page }) => {
    const { uid } = await readyToRequest(page, 'req-late');
    await requestRide(page).click();
    await confirm(page).click();
    await expect(requestedCard(page)).toBeVisible();
    const [trip] = await tripsOf(uid);
    if (!trip) throw new Error('The request was not stored.');

    // What a later module will do when a driver is found: change the status on the server.
    const response = await fetch(
      `${firestoreDocs}/${trip.name.split('/documents/')[1]}?updateMask.fieldPaths=status`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
        body: JSON.stringify({ fields: { status: { stringValue: 'MATCHED' } } }),
      },
    );
    expect(response.ok).toBe(true);

    await expect(requestedCard(page)).toBeVisible();
    await expect(cancelRequest(page)).toHaveCount(0);
  });

  test('keeps the request button clear of the location button', async ({ page }) => {
    await readyToRequest(page, 'req-layout');

    const button = await requestRide(page).boundingBox();
    const locate = await page.getByRole('button', { name: 'Show my location' }).boundingBox();
    if (!button || !locate) throw new Error('The buttons are not on screen.');
    expect(button.y + button.height).toBeLessThanOrEqual(locate.y + 1);
  });
});
