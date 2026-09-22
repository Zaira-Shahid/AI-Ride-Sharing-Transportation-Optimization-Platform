import { expect, test, type Page } from '@playwright/test';
import { describeEstimate, ESTIMATE_CAVEAT } from '../../packages/types/src';
import { defaultRouteBody } from '../fake-osrm';
import { E2E_GEOCODING } from '../fake-nominatim';
import {
  PASSWORD,
  PLACES,
  apps,
  createAccount,
  functionsUrl,
  journeyId,
  mockPlaces,
  openLogin,
  readDriverAvailability,
  readDriverJourney,
  signInIdToken,
  submitLogin,
  uniqueEmail,
  writeDriverDoc,
  writeJourneyDoc,
  writeVehicleDoc,
} from './helpers';
import { newPassenger, watchMap } from './map-helpers';
import {
  chooseDestination,
  confirm,
  requestRide,
  requestedCard,
  reviewCard,
  tripsOf,
} from './trip-helpers';

// Phase 4 acceptance (spec: "The system can calculate realistic routes"). Each module already has
// its own tests; this drives the whole phase together through the real screens - a position from the
// device (GPS, 4.1) turned into an address (geocoding, 4.2) and into a route with a realistic
// distance, time and line (route calculation, 4.3; distance and ETA, 4.4-4.5; the line, 4.7), for a
// driver's journey start and for a passenger's pickup and request. Walking (4.6) has no screen yet
// (it is for a pickup point, Phase 5), so it is asked for directly, the way matching will.

const [, driver] = apps;
const { office, station } = PLACES;

const ADDRESS = '12 Test Street, Bristol, BS1 6QS';

async function allowLocation(page: Page, where: { latitude: number; longitude: number }) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation(where);
}

const map = (page: Page) => page.getByRole('region', { name: 'Map' });
const pickupMarker = (page: Page) => map(page).getByTitle('Pickup', { exact: true });
const destinationMarker = (page: Page) => map(page).getByTitle('Destination', { exact: true });
const routeLine = (page: Page) => map(page).locator('.ridemesh-route-line');
const useMyLocation = (page: Page) =>
  page.getByRole('button', { name: 'Use my current location', exact: true });
const estimateOf = (card: ReturnType<typeof reviewCard>) => card.getByLabel('Estimated trip');

test.describe('phase 4 acceptance: the system can calculate realistic routes', () => {
  test("a driver's start comes from GPS, with the address geocoding finds for it, and the driver can go online", async ({
    page,
  }) => {
    await allowLocation(page, E2E_GEOCODING.found);
    const email = uniqueEmail('phase4-drv');
    const uid = await createAccount(email, driver.role, true, 'Dan Driver', {
      name: 'Dan Driver',
      phone: '+44 7700 900123',
    });
    await writeJourneyDoc(uid, office, 3, { minutes: 10, km: 5 }, null);
    await writeDriverDoc(uid, { verificationStatus: 'VERIFIED', currentJourneyId: journeyId(uid) });
    await writeVehicleDoc(uid, { verificationStatus: 'VERIFIED', seatCapacity: 4 });
    await openLogin(page, driver.url, driver.title);
    await submitLogin(page, email, PASSWORD);

    const startCard = page.getByLabel('Start of journey', { exact: true });
    await startCard.getByRole('button', { name: 'Use my current location as the start' }).click();

    // GPS (4.1) gave the position; geocoding (4.2) turned it into this address.
    await expect(startCard.getByText('Your start has been saved.')).toBeVisible();
    await expect(startCard.getByText(ADDRESS, { exact: true })).toBeVisible();
    const origin = (await readDriverJourney(uid))?.origin;
    expect(origin?.address).toBe(ADDRESS);
    expect(origin?.latitude).toBeCloseTo(E2E_GEOCODING.found.latitude, 6);
    expect(origin?.longitude).toBeCloseTo(E2E_GEOCODING.found.longitude, 6);

    const goOnline = page.getByRole('button', { name: 'Go online', exact: true });
    await expect(goOnline).toBeEnabled();
    await goOnline.click();
    await expect(page.getByText('You are online')).toBeVisible();
    await expect.poll(() => readDriverAvailability(uid)).toBe('ONLINE');
  });

  test("a passenger's pickup from GPS gets a route with a realistic distance, time and line to the destination, before and after the request is sent", async ({
    page,
  }) => {
    await allowLocation(page, E2E_GEOCODING.found);
    await mockPlaces(page);
    await watchMap(page);
    const { uid } = await newPassenger(page, 'phase4-pax');
    await chooseDestination(page, 'canary', office.text);

    // GPS (4.1) and geocoding (4.2): the pickup is the device's position, shown by the address found
    // for it.
    await useMyLocation(page).click();
    await expect(page.getByLabel('Pickup', { exact: true }).getByText(ADDRESS)).toBeVisible();

    // What the fake route server (a stand-in for OSRM, module 4.3) gives for these two stops: a route
    // that says what it is for (its distance and time follow from the actual stops, at a driving
    // pace), not a fixed answer.
    const route = defaultRouteBody({
      stops: [
        { latitude: E2E_GEOCODING.found.latitude, longitude: E2E_GEOCODING.found.longitude },
        { latitude: office.latitude, longitude: office.longitude },
      ],
    }).routes[0];
    const distanceMeters = Math.round(route?.distance ?? Number.NaN);
    const durationSeconds = Math.round(route?.duration ?? Number.NaN);
    const estimate = describeEstimate({ distanceMeters, durationSeconds });

    // At the review (4.4, 4.5): the estimate, and the line drawn between the two places (4.7).
    await requestRide(page).click();
    await expect(reviewCard(page)).toBeVisible();
    await expect(estimateOf(reviewCard(page)).getByText(estimate, { exact: true })).toBeVisible();
    await expect(estimateOf(reviewCard(page)).getByText(ESTIMATE_CAVEAT)).toBeVisible();
    await expect(pickupMarker(page)).toBeVisible();
    await expect(destinationMarker(page)).toBeVisible();
    await expect(routeLine(page)).toBeVisible();

    await confirm(page).click();

    // On the ride requested: the same route, asked for again and answered from the cache.
    await expect(requestedCard(page)).toBeVisible();
    await expect(
      estimateOf(requestedCard(page)).getByText(estimate, { exact: true }),
    ).toBeVisible();
    await expect(pickupMarker(page)).toBeVisible();
    await expect(destinationMarker(page)).toBeVisible();
    await expect(routeLine(page)).toBeVisible();

    // And what was stored is exactly that route.
    const [trip] = await tripsOf(uid);
    const fields = trip?.fields as unknown as Record<
      string,
      { integerValue?: string; doubleValue?: number }
    >;
    expect(Number(fields.estimatedDistance?.integerValue)).toBe(distanceMeters);
    expect(Number(fields.estimatedDuration?.integerValue)).toBe(durationSeconds);
  });

  test('a walking route is calculated too, at a walking pace, distinct from a driving one', async ({
    page,
  }) => {
    // Walking (4.6) has no screen yet - pickup points are assigned by matching, Phase 5 - so it is
    // asked for the way matching eventually will: the real callable, as a verified passenger.
    await mockPlaces(page);
    const { email } = await newPassenger(page, 'phase4-walk');
    const idToken = await signInIdToken(email);
    const stops = [
      { latitude: station.latitude, longitude: station.longitude },
      { latitude: office.latitude, longitude: office.longitude },
    ];

    const call = async (profile?: 'driving' | 'walking') => {
      const response = await fetch(`${functionsUrl}/calculateRoute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ data: { stops, ...(profile ? { profile } : {}) } }),
      });
      expect(response.ok).toBe(true);
      const { result } = (await response.json()) as {
        result: {
          status: string;
          route: { distanceMeters: number; durationSeconds: number } | null;
        };
      };
      return result;
    };

    const driving = await call();
    const walking = await call('walking');

    expect(driving.status).toBe('found');
    expect(walking.status).toBe('found');
    const expectedDriving = defaultRouteBody({ stops, profile: 'driving' }).routes[0];
    const expectedWalking = defaultRouteBody({ stops, profile: 'walking' }).routes[0];
    expect(driving.route?.durationSeconds).toBe(
      Math.round(expectedDriving?.duration ?? Number.NaN),
    );
    expect(walking.route?.durationSeconds).toBe(
      Math.round(expectedWalking?.duration ?? Number.NaN),
    );
    // The same distance on foot takes much longer than by road: a realistic route for each mode, not
    // the same answer with the label changed.
    expect(walking.route?.durationSeconds).toBeGreaterThan(driving.route?.durationSeconds ?? 0);
  });
});
