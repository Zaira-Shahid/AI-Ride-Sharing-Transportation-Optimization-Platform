import { expect, test, type Page } from '@playwright/test';
import { PLACES, mockPlaces } from './helpers';
import { newPassenger, watchMap } from './map-helpers';
import {
  cancelRequest,
  choosePickup,
  chooseDestination,
  confirm,
  destinationCard,
  readyToRequest,
  requestRide,
  requestedCard,
  setTripStatus,
  tripsOf,
} from './trip-helpers';

const { farNorthStart, farNorthEnd } = PLACES;

/**
 * A passenger with both places chosen, ready to request a ride - like readyToRequest, but at a
 * corner of the world no other e2e spec's driver is ever near (Modules 5.2-5.5), for a test that
 * needs its request to stay exactly in the status it is put in and never be matched for real.
 */
async function readyToRequestUnmatchable(page: Page, prefix: string) {
  await mockPlaces(page);
  const watch = await watchMap(page);
  const { uid } = await newPassenger(page, prefix);
  await chooseDestination(page, 'thistle', farNorthEnd.text);
  await choosePickup(page, 'kelpie', farNorthStart.text);
  return { uid, watch };
}

const heading = (page: Page, name: string) =>
  requestedCard(page).getByRole('heading', { name, exact: true });
const goToTrips = (page: Page) => page.getByRole('tab', { name: 'Trips' }).click();
const goHome = (page: Page) => page.getByRole('tab', { name: 'Home' }).click();
const upcoming = (page: Page) => page.getByLabel('Upcoming', { exact: true });
const past = (page: Page) => page.getByLabel('Past', { exact: true });
const rows = (group: ReturnType<typeof upcoming>) => group.getByLabel(/^Trip: /);

/** What the card says for each open status, and whether the passenger may cancel from it. */
const OPEN_STATUSES = [
  ['REQUESTED', 'Ride requested', true],
  ['SEARCHING', 'Finding your ride', true],
  ['MATCHED', 'Driver found', false],
  ['PICKUP_ASSIGNED', 'Pickup arranged', false],
  ['DRIVER_ARRIVING', 'Your driver is on the way', false],
  ['PICKED_UP', 'You are on board', false],
  ['IN_TRANSIT', 'On your way', false],
  ['DROPOFF_APPROACHING', 'Almost there', false],
] as const;

test.describe('passenger app: trip status', () => {
  test('follows the request through every status, and offers cancel only while it is free', async ({
    page,
  }) => {
    // No driver is ever near this request (Modules 5.2-5.5), so its status only ever changes here,
    // by hand - the walk below needs a known, stable starting point.
    const { uid } = await readyToRequestUnmatchable(page, 'status-walk');
    await requestRide(page).click();
    await confirm(page).click();
    await expect(requestedCard(page)).toBeVisible();
    const [trip] = await tripsOf(uid);
    if (!trip) throw new Error('The request was not stored.');

    for (const [status, title, cancellable] of OPEN_STATUSES) {
      // The server moves the request along; the app is not reloaded. Always set, even for
      // REQUESTED: the search-starting trigger (Modules 5.2 and 5.3) moves every request on to
      // SEARCHING moments after creation, so the walk needs to pin it back for its first step too.
      await setTripStatus(trip, status);
      await expect(heading(page, title)).toBeVisible();
      if (cancellable) await expect(cancelRequest(page)).toBeVisible();
      else await expect(cancelRequest(page)).toHaveCount(0);
      // It is still the same request: the places are on the card the whole way.
      await expect(requestedCard(page).getByText(farNorthStart.address)).toBeVisible();
      await expect(requestedCard(page).getByText(farNorthEnd.address)).toBeVisible();
    }

    // When the trip is over, Home goes back to planning.
    await setTripStatus(trip, 'COMPLETED');
    await expect(requestedCard(page)).toHaveCount(0);
    await expect(destinationCard(page)).toBeVisible();
  });

  test('lets the passenger cancel while the request is being searched for', async ({ page }) => {
    const { uid } = await readyToRequestUnmatchable(page, 'status-cancel-search');
    await requestRide(page).click();
    await confirm(page).click();
    await expect(requestedCard(page)).toBeVisible();
    const [trip] = await tripsOf(uid);
    if (!trip) throw new Error('The request was not stored.');
    await setTripStatus(trip, 'SEARCHING');
    await expect(heading(page, 'Finding your ride')).toBeVisible();

    await cancelRequest(page).click();
    await page.getByRole('button', { name: 'Yes, cancel it', exact: true }).click();

    await expect(requestedCard(page)).toHaveCount(0);
    await expect(requestRide(page)).toBeEnabled();
    const [after] = await tripsOf(uid);
    expect(after?.fields.status?.stringValue).toBe('CANCELLED');
  });

  test('says so, in the Trips tab, when there are no trips', async ({ page }) => {
    await mockPlaces(page);
    await watchMap(page);
    await newPassenger(page, 'trips-empty');

    await goToTrips(page);

    await expect(page.getByText('No trips yet', { exact: true })).toBeVisible();
    await expect(page.getByText('Your past and upcoming trips will appear here.')).toBeVisible();
    await expect(upcoming(page)).toHaveCount(0);
    await expect(past(page)).toHaveCount(0);
  });

  test('lists upcoming and past requests, and moves a request between them live', async ({
    page,
  }) => {
    // No driver is ever near this request (Modules 5.2-5.5), so it is never matched away while this
    // test still needs to cancel it - only the REQUESTED -> SEARCHING move (Modules 5.2 and 5.3,
    // which happens whether or not a candidate is found) can still race the check below.
    await readyToRequestUnmatchable(page, 'trips-list');
    await requestRide(page).click();
    await confirm(page).click();
    await expect(requestedCard(page)).toBeVisible();

    await goToTrips(page);
    await expect(rows(upcoming(page))).toHaveCount(1);
    const first = upcoming(page).getByLabel(/^Trip: (Requested|Finding a ride)$/);
    await expect(first.getByText(`From ${farNorthStart.address}`)).toBeVisible();
    await expect(first.getByText(`To ${farNorthEnd.address}`)).toBeVisible();
    await expect(past(page)).toHaveCount(0);

    // Cancel from Home; the list follows.
    await goHome(page);
    await cancelRequest(page).click();
    await page.getByRole('button', { name: 'Yes, cancel it', exact: true }).click();
    await expect(requestedCard(page)).toHaveCount(0);
    await goToTrips(page);
    await expect(upcoming(page)).toHaveCount(0);
    await expect(rows(past(page))).toHaveCount(1);
    await expect(past(page).getByLabel('Trip: Cancelled')).toBeVisible();

    // A second request is upcoming, and the cancelled one stays in the past.
    await goHome(page);
    await requestRide(page).click();
    await confirm(page).click();
    await expect(requestedCard(page)).toBeVisible();
    await goToTrips(page);
    await expect(rows(upcoming(page))).toHaveCount(1);
    await expect(rows(past(page))).toHaveCount(1);
  });

  test('shows only the passenger own trips', async ({ page, browser }) => {
    await readyToRequest(page, 'trips-own');
    await requestRide(page).click();
    await confirm(page).click();
    await expect(requestedCard(page)).toBeVisible();

    // Another passenger, in their own browser, has a request of their own.
    const other = await browser.newPage();
    try {
      await readyToRequest(other, 'trips-other');
      await requestRide(other).click();
      await confirm(other).click();
      await expect(requestedCard(other)).toBeVisible();
      await goToTrips(other);
      await expect(rows(upcoming(other))).toHaveCount(1);
    } finally {
      await other.close();
    }

    await goToTrips(page);
    await expect(rows(upcoming(page))).toHaveCount(1);
  });
});
