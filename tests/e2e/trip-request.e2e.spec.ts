import { expect, test, type Page } from '@playwright/test';
import { PLACES, mockPlaces } from './helpers';
import { newPassenger, watchMap } from './map-helpers';
import {
  cancelRequest,
  chooseDestination,
  choosePickup,
  confirm,
  destinationCard,
  pickupCard,
  readyToRequest,
  requestRide,
  requestedCard,
  reviewCard,
  setTripStatus,
  statusOf,
  tripsOf,
} from './trip-helpers';

const { office, station, farNorthStart, farNorthEnd } = PLACES;

/**
 * A passenger with both places chosen, ready to request a ride - like readyToRequest, but at a
 * corner of the world no other e2e spec's driver is ever near (Modules 5.2-5.5), for a test that
 * needs its request to stay free to cancel and never be matched for real.
 */
async function readyToRequestUnmatchable(page: Page, prefix: string) {
  await mockPlaces(page);
  const watch = await watchMap(page);
  const { uid } = await newPassenger(page, prefix);
  await chooseDestination(page, 'thistle', farNorthEnd.text);
  await choosePickup(page, 'kelpie', farNorthStart.text);
  return { uid, watch };
}

const map = (page: Page) => page.getByRole('region', { name: 'Map' });
const pickupMarker = (page: Page) => map(page).getByTitle('Pickup', { exact: true });
const destinationMarker = (page: Page) => map(page).getByTitle('Destination', { exact: true });
// The route line (Module 4.7): its own CSS class, since Leaflet gives it no title or role.
const routeLine = (page: Page) => map(page).locator('.ridemesh-route-line');

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
    // The places are not on show for editing while reviewing. The review asks the server for the
    // estimated trip time (one route lookup) and nothing else: no request is created or stored.
    await expect(destinationCard(page)).toHaveCount(0);
    await expect(reviewCard(page).getByLabel('Estimated trip')).toBeVisible();
    // The same lookup draws the route line on the map (Module 4.7), not a second one.
    await expect(routeLine(page)).toBeVisible();
    expect(watch.serverCalls).toHaveLength(1);
    expect(watch.serverCalls[0]).toContain('/calculateRoute');
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
    // The route line is asked for again for the requested card (Module 4.7), and answered from
    // the cache the trigger already filled when the request was created.
    await expect(routeLine(page)).toBeVisible();
    // The planning cards and the request button give way to the request.
    await expect(destinationCard(page)).toHaveCount(0);
    await expect(requestRide(page)).toHaveCount(0);

    const trips = await tripsOf(uid);
    expect(trips).toHaveLength(1);
    // The search-starting trigger (Modules 5.2 and 5.3) may already have moved this on to
    // SEARCHING by now.
    expect(['REQUESTED', 'SEARCHING']).toContain(statusOf(trips[0]));
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
    // No driver is ever near this request (Modules 5.2-5.5), so it stays free to cancel throughout.
    const { uid } = await readyToRequestUnmatchable(page, 'req-keep');
    await requestRide(page).click();
    await confirm(page).click();
    await expect(requestedCard(page)).toBeVisible();

    await cancelRequest(page).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Keep request', exact: true }).click();

    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(requestedCard(page)).toBeVisible();
    // The search-starting trigger (Modules 5.2 and 5.3) moves every request on to SEARCHING moments
    // after creation, whether or not a candidate is found.
    expect(['REQUESTED', 'SEARCHING']).toContain(statusOf((await tripsOf(uid))[0]));
  });

  test('cancels the request after confirming, and returns to planning with the choices kept', async ({
    page,
  }) => {
    // No driver is ever near this request (Modules 5.2-5.5), so it stays free to cancel throughout.
    const { uid } = await readyToRequestUnmatchable(page, 'req-cancel');
    await requestRide(page).click();
    await confirm(page).click();
    await expect(requestedCard(page)).toBeVisible();

    await cancelRequest(page).click();
    await page.getByRole('button', { name: 'Yes, cancel it', exact: true }).click();

    await expect(requestedCard(page)).toHaveCount(0);
    await expect(destinationCard(page).getByText(farNorthEnd.address)).toBeVisible();
    await expect(pickupCard(page).getByText(farNorthStart.address)).toBeVisible();
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
    await setTripStatus(trip, 'MATCHED');

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
