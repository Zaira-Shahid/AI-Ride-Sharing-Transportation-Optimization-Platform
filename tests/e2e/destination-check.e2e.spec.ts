import { expect, test, type Page } from '@playwright/test';
import { PLACES, mockPlaces } from './helpers';
import { newPassenger, watchMap } from './map-helpers';

const { office, station, nowhere, sydney } = PLACES;

const UNUSABLE = 'That place cannot be used for a trip. Please choose another.';

const map = (page: Page) => page.getByRole('region', { name: 'Map' });
const destinationMarker = (page: Page) => map(page).getByTitle('Destination', { exact: true });
const pickupMarker = (page: Page) => map(page).getByTitle('Pickup', { exact: true });
const destinationCard = (page: Page) => page.getByLabel('Where to', { exact: true });
const pickupCard = (page: Page) => page.getByLabel('Pickup', { exact: true });
const searchDestination = (page: Page) => page.getByLabel('Search for a destination');
const searchPickup = (page: Page) => page.getByLabel('Search for a pickup');

// Google answers with exactly 0, 0 for a place whose position was never filled in. The place passes
// the shape rules of the search, so it is the trip's own check that has to refuse it.
test.describe('passenger app: a destination that cannot be used', () => {
  test('refuses a destination with no position, says why, and keeps the search open', async ({
    page,
  }) => {
    await mockPlaces(page);
    const watch = await watchMap(page);
    await newPassenger(page, 'dst-nowhere');
    watch.serverCalls.length = 0;

    await searchDestination(page).fill('nowhere');
    await destinationCard(page).getByRole('button', { name: nowhere.text }).click();

    await expect(destinationCard(page).getByText(UNUSABLE)).toBeVisible();
    await expect(destinationCard(page).getByText('Heading to')).toHaveCount(0);
    await expect(destinationMarker(page)).toHaveCount(0);
    await expect(searchDestination(page)).toBeVisible();
    expect(watch.serverCalls).toEqual([]);

    // A real place is accepted after it, and the message goes.
    await searchDestination(page).fill('canary');
    await destinationCard(page).getByRole('button', { name: office.text }).click();
    await expect(destinationCard(page).getByText(office.address)).toBeVisible();
    await expect(destinationMarker(page)).toBeVisible();
    await expect(page.getByText(UNUSABLE)).toHaveCount(0);
  });

  test('refuses a pickup with no position in the same way', async ({ page }) => {
    await mockPlaces(page);
    await watchMap(page);
    await newPassenger(page, 'pick-nowhere');

    await searchPickup(page).fill('nowhere');
    await pickupCard(page).getByRole('button', { name: nowhere.text }).click();

    await expect(pickupCard(page).getByText(UNUSABLE)).toBeVisible();
    await expect(pickupCard(page).getByText('Picking up at')).toHaveCount(0);
    await expect(pickupMarker(page)).toHaveCount(0);
    await expect(searchPickup(page)).toBeVisible();

    await searchPickup(page).fill('temple');
    await pickupCard(page).getByRole('button', { name: station.text }).click();
    await expect(pickupCard(page).getByText(station.address)).toBeVisible();
    await expect(page.getByText(UNUSABLE)).toHaveCount(0);
  });

  test('a refused place leaves the other place as it was', async ({ page }) => {
    await mockPlaces(page);
    await watchMap(page);
    await newPassenger(page, 'dst-keep');
    await searchDestination(page).fill('canary');
    await destinationCard(page).getByRole('button', { name: office.text }).click();
    await searchPickup(page).fill('temple');
    await pickupCard(page).getByRole('button', { name: station.text }).click();

    // "Change destination" clears the old destination; the unusable place then chosen is refused,
    // so the destination stays empty and the pickup is untouched.
    await page.getByRole('button', { name: 'Change destination' }).click();
    await searchDestination(page).fill('nowhere');
    await destinationCard(page).getByRole('button', { name: nowhere.text }).click();
    await expect(destinationCard(page).getByText(UNUSABLE)).toBeVisible();
    await expect(pickupCard(page).getByText(station.address)).toBeVisible();
    await expect(pickupMarker(page)).toBeVisible();
    await expect(destinationMarker(page)).toHaveCount(0);
  });

  test('has no service area: a trip from one side of the world to the other is accepted', async ({
    page,
  }) => {
    await mockPlaces(page);
    await watchMap(page);
    await newPassenger(page, 'dst-anywhere');

    await searchPickup(page).fill('sydney');
    await pickupCard(page).getByRole('button', { name: sydney.text }).click();
    await searchDestination(page).fill('canary');
    await destinationCard(page).getByRole('button', { name: office.text }).click();

    await expect(pickupCard(page).getByText(sydney.address)).toBeVisible();
    await expect(destinationCard(page).getByText(office.address)).toBeVisible();
    await expect(pickupMarker(page)).toBeVisible();
    await expect(destinationMarker(page)).toBeVisible();
    await expect(page.getByText(UNUSABLE)).toHaveCount(0);
  });
});
