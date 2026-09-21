import { expect, test, type Page } from '@playwright/test';
import { describeEstimate, ESTIMATE_CAVEAT } from '../../packages/types/src';
import { E2E_ROUTING, defaultRouteBody } from '../fake-osrm';
import { PLACES, mockPlaces } from './helpers';
import { newPassenger, watchMap } from './map-helpers';
import {
  chooseDestination,
  confirm,
  readyToRequest,
  requestRide,
  requestedCard,
  reviewCard,
  tripsOf,
} from './trip-helpers';

// Modules 4.4 and 4.5. The passenger sees how long the trip is estimated to take before they confirm
// (the app asks the server for the route), and afterwards on the ride they requested and in their
// trips (the server writes the estimate onto the request a moment after it is made). Times have no
// live traffic and say so. The route server is a fake (tests/fake-osrm.ts, started by
// global-setup.ts) that answers by the stops, so what the screens should say is worked out here from
// the same stops.

const { office, station } = PLACES;

test.use({ locale: 'en-GB', timezoneId: 'Europe/London' });

// The route from the pickup to the destination as the fake gives it, and how the screens write it.
const route = defaultRouteBody({
  stops: [
    { latitude: station.latitude, longitude: station.longitude },
    { latitude: office.latitude, longitude: office.longitude },
  ],
}).routes[0];
const DISTANCE = Math.round(route?.distance ?? Number.NaN);
const DURATION = Math.round(route?.duration ?? Number.NaN);
const ESTIMATE = describeEstimate({ distanceMeters: DISTANCE, durationSeconds: DURATION });

const estimateOf = (card: ReturnType<typeof reviewCard>) => card.getByLabel('Estimated trip');
const timeCard = (page: Page) => page.getByLabel('When', { exact: true });
const chip = (page: Page, groupName: string, name: string) =>
  timeCard(page).getByRole('radiogroup', { name: groupName, exact: true }).getByRole('radio', {
    name,
    exact: true,
  });
const WARNING =
  /This trip is estimated at .+, so you may not arrive by .+\. You can still request it\./;

/**
 * The day and hour chips for a time about `hoursAhead` hours from now, in the time zone the tests run
 * in, written the way the app writes them. A time a couple of hours away is what a "tight" arrival
 * needs here: well inside the trip time (so it warns), and far from the 5-minute minimum that the
 * server checks again when the request is confirmed (the earliest slot on offer is only just over it,
 * and a test that takes a few seconds can slip under it).
 */
function timeAhead(hoursAhead: number) {
  const now = Date.now();
  const target = now + hoursAhead * 60 * 60_000;
  const dayOf = (at: number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(at);
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone: 'Europe/London',
    }).format(target),
  );
  return {
    day: dayOf(target) === dayOf(now) ? ('Today' as const) : ('Tomorrow' as const),
    // The chip is labelled as the app labels an hour: the same formatter, for that hour.
    hour: new Intl.DateTimeFormat('en-GB', { hour: 'numeric' }).format(new Date(2000, 0, 1, hour)),
  };
}

async function arriveBy(page: Page, day: 'Today' | 'Tomorrow' | null, hour: string | null) {
  await timeCard(page).getByRole('button', { name: 'Change times' }).click();
  await timeCard(page).getByRole('radio', { name: 'Arrive by a time', exact: true }).click();
  if (day) await chip(page, 'Arrive by: day', day).click();
  if (hour) await chip(page, 'Arrive by: hour', hour).click();
  await timeCard(page).getByRole('button', { name: 'Done' }).click();
}

test.describe('passenger app: the estimated trip', () => {
  test('is shown before confirming, then on the ride requested and in the trips, and is stored', async ({
    page,
  }) => {
    const { uid } = await readyToRequest(page, 'est-flow');

    // Before confirming: the time and distance, and that there is no live traffic in them.
    await requestRide(page).click();
    await expect(estimateOf(reviewCard(page)).getByText(ESTIMATE, { exact: true })).toBeVisible();
    await expect(estimateOf(reviewCard(page)).getByText(ESTIMATE_CAVEAT)).toBeVisible();
    await expect(reviewCard(page).getByText(WARNING)).toHaveCount(0);

    // Nothing is stored yet.
    expect(await tripsOf(uid)).toHaveLength(0);

    await confirm(page).click();

    // The server writes the estimate on the request a moment after it is made, and the card, which
    // follows the request, shows it without a reload.
    await expect(
      estimateOf(requestedCard(page)).getByText(ESTIMATE, { exact: true }),
    ).toBeVisible();
    await expect(estimateOf(requestedCard(page)).getByText(ESTIMATE_CAVEAT)).toBeVisible();
    const [trip] = await tripsOf(uid);
    const fields = trip?.fields as unknown as Record<
      string,
      { integerValue?: string; doubleValue?: number }
    >;
    // Metres and whole seconds, as a route has them.
    expect(Number(fields.estimatedDistance?.integerValue)).toBe(DISTANCE);
    expect(Number(fields.estimatedDuration?.integerValue)).toBe(DURATION);

    // And in the trips.
    await page.getByRole('tab', { name: 'Trips' }).click();
    await expect(
      page.getByLabel('Trip: Requested').getByText(`Estimated ${ESTIMATE}`, { exact: true }),
    ).toBeVisible();
  });

  test('warns, without refusing, when the arrival time leaves less than the trip takes', async ({
    page,
  }) => {
    await readyToRequest(page, 'est-tight');
    // An arrival about two hours from now: far less than the 4 h 37 min the trip is estimated at.
    const { day, hour } = timeAhead(2);
    await arriveBy(page, day, hour);

    await requestRide(page).click();

    await expect(estimateOf(reviewCard(page)).getByText(ESTIMATE, { exact: true })).toBeVisible();
    await expect(reviewCard(page).getByText(WARNING)).toBeVisible();
    // It is a warning: the request can still be sent.
    await expect(confirm(page)).toBeEnabled();
    await confirm(page).click();
    await expect(requestedCard(page)).toBeVisible();
  });

  test('does not warn when there is plenty of time', async ({ page }) => {
    await readyToRequest(page, 'est-plenty');
    // Tomorrow at 23:00 is more than 13 hours away, whatever the time now: far more than the trip.
    await arriveBy(page, 'Tomorrow', '23');

    await requestRide(page).click();

    await expect(estimateOf(reviewCard(page)).getByText(ESTIMATE, { exact: true })).toBeVisible();
    await expect(reviewCard(page).getByText(WARNING)).toHaveCount(0);
  });

  test('says the estimate could not be made, and lets the request go ahead', async ({ page }) => {
    // The fake route server fails for a trip that starts near this position.
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({
      latitude: E2E_ROUTING.failing.latitude + 0.00004,
      longitude: E2E_ROUTING.failing.longitude + 0.00003,
    });
    await mockPlaces(page);
    await watchMap(page);
    const { uid } = await newPassenger(page, 'est-fail');
    await chooseDestination(page, 'canary', office.text);
    await page.getByRole('button', { name: 'Use my current location', exact: true }).click();
    await expect(
      page.getByLabel('Pickup', { exact: true }).getByText('Picking up at'),
    ).toBeVisible();

    await requestRide(page).click();

    await expect(
      estimateOf(reviewCard(page)).getByText(
        'We could not estimate the trip time. You can still request the ride.',
      ),
    ).toBeVisible();
    await expect(confirm(page)).toBeEnabled();
    await confirm(page).click();

    // The request is made, and says the estimate is being worked out; none comes, and nothing else
    // about the request is affected.
    await expect(requestedCard(page)).toBeVisible();
    await expect(
      estimateOf(requestedCard(page)).getByText('Estimating the trip time.'),
    ).toBeVisible();
    await page.waitForTimeout(2_500);
    const [trip] = await tripsOf(uid);
    const fields = trip?.fields as unknown as Record<string, { nullValue?: null }>;
    expect(fields.estimatedDistance).toEqual({ nullValue: null });
    expect(fields.estimatedDuration).toEqual({ nullValue: null });
    await expect(
      requestedCard(page).getByRole('heading', { name: 'Ride requested' }),
    ).toBeVisible();
  });
});
