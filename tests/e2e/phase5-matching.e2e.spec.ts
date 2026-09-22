import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  PLACES,
  apps,
  createAccount,
  journeyId,
  mockPlaces,
  openLogin,
  readDriverJourney,
  submitLogin,
  uniqueEmail,
  writeDriverDoc,
  writeJourneyDoc,
  writeVehicleDoc,
} from './helpers';
import { newPassenger, watchMap } from './map-helpers';
import {
  choosePickup,
  chooseDestination,
  confirm,
  requestRide,
  requestedCard,
  tripsOf,
} from './trip-helpers';

// Phase 5 acceptance (spec: "the system can automatically match simple shared trips"). Each module
// (5.1-5.5) already has its own tests; this drives the whole phase together through the real screens:
// a driver goes online with an eligible journey, a passenger requests a ride nearby heading the same
// way, and the request is matched to that driver with no one telling the system to match them - the
// candidate discovery (5.2), the search starting (5.3), the route check (5.4) and the assignment
// (5.5) all happen on their own, moments after the request is made.
//
// Its own corner of the world (PLACES.farNorthStart/End), well away from the office/station route
// most other e2e specs use for their own drivers: many of them leave a driver ONLINE (an AVAILABLE
// journey candidate, Module 5.1) there when they finish, which would make which driver gets matched
// here a coin toss otherwise.

const [, driverApp] = apps;
const { farNorthStart, farNorthEnd } = PLACES;

const goOnline = (page: Page) => page.getByRole('button', { name: 'Go online', exact: true });

test.describe('phase 5 acceptance: the system can automatically match simple shared trips', () => {
  test('a request is matched to a nearby online driver heading the same way, with no one matching them by hand', async ({
    browser,
  }) => {
    const driverContext = await browser.newContext();
    const driverPage = await driverContext.newPage();
    const passengerContext = await browser.newContext();
    const passengerPage = await passengerContext.newPage();

    // The driver: destination, seats and detour are set directly (Modules 2.6-2.8 already have their
    // own tests for the screens that set them); going online is the one real action this test cares
    // about.
    const driverEmail = uniqueEmail('phase5-drv');
    const driverUid = await createAccount(driverEmail, driverApp.role, true, 'Dan Driver', {
      name: 'Dan Driver',
      phone: '+44 7700 900123',
    });
    await writeJourneyDoc(driverUid, farNorthEnd, 3, { minutes: 10, km: 5 }, farNorthStart);
    await writeDriverDoc(driverUid, {
      verificationStatus: 'VERIFIED',
      currentJourneyId: journeyId(driverUid),
    });
    await writeVehicleDoc(driverUid, { verificationStatus: 'VERIFIED', seatCapacity: 4 });
    await openLogin(driverPage, driverApp.url, driverApp.title);
    await submitLogin(driverPage, driverEmail, PASSWORD);

    await expect(goOnline(driverPage)).toBeEnabled();
    await goOnline(driverPage).click();
    await expect.poll(async () => (await readDriverJourney(driverUid))?.status).toBe('AVAILABLE');

    // The passenger: the same pickup and destination as the driver's own journey, so the smallest
    // possible detour.
    await mockPlaces(passengerPage);
    await watchMap(passengerPage);
    const { uid: passengerUid } = await newPassenger(passengerPage, 'phase5-psg');
    await chooseDestination(passengerPage, 'thistle', farNorthEnd.text);
    await choosePickup(passengerPage, 'kelpie', farNorthStart.text);
    await requestRide(passengerPage).click();
    await confirm(passengerPage).click();
    await expect(requestedCard(passengerPage)).toBeVisible();

    // Nobody here tells the system who to match: candidate discovery, starting the search, the route
    // check and the assignment (Modules 5.2-5.5) all run on their own, moments after the request was
    // made.
    await expect(requestedCard(passengerPage).getByText('Driver found')).toBeVisible({
      timeout: 30_000,
    });

    const trips = await tripsOf(passengerUid);
    const trip = trips[0];
    expect(trip?.fields.status?.stringValue).toBe('MATCHED');
    expect(trip?.fields.matchedDriverId?.stringValue).toBe(driverUid);
    expect(trip?.fields.matchedJourneyId?.stringValue).toBe(journeyId(driverUid));

    const journey = await readDriverJourney(driverUid);
    expect(journey?.status).toBe('MATCHING');

    await driverContext.close();
    await passengerContext.close();
  });
});
