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
  readJourneyStatus,
  submitLogin,
  uniqueEmail,
  writeDriverDoc,
  writeJourneyDoc,
  writeVehicleDoc,
} from './helpers';
import { newPassenger, watchMap } from './map-helpers';
import { triggerBatchOptimization } from './trigger-batch';
import {
  choosePickup,
  chooseDestination,
  confirm,
  requestRide,
  requestedCard,
  tripsOf,
} from './trip-helpers';

// Phase 5/6 acceptance (spec: "the system can automatically match simple shared trips"). Each module
// already has its own tests; this drives the whole pipeline together through the real screens: a
// driver goes online with an eligible journey, a passenger requests a ride nearby heading the same
// way, candidate discovery and the search starting (Modules 5.2/5.3) happen on their own, moments
// after the request is made - nobody in this test tells the system who to match.
//
// Actual assignment is no longer instant (Module 6.10 replaced Module 5.5's per-request auto-match
// with a periodic batch run, every 2 minutes in production): this test fires that batch run directly
// (triggerBatchOptimization) rather than waiting for its real schedule, the same way the integration
// tests do. The optimization service itself is scripted there, not the real Python service - that is
// Phase 6's own acceptance test's job (tests/integration/phase6-acceptance.int.test.ts); this test is
// about the real screens and the real Firestore trigger chain around the batch, not the optimizer's
// own logic.
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

    // Nobody here tells the system to start searching: candidate discovery and starting the search
    // (Modules 5.2/5.3) run on their own, moments after the request was made.
    await expect(requestedCard(passengerPage).getByText('Finding your ride')).toBeVisible({
      timeout: 30_000,
    });

    const tripId = (await tripsOf(passengerUid))[0]?.name.split('/').pop();
    expect(tripId).toEqual(expect.any(String));

    // Fires the periodic batch run directly (see the file header comment) rather than waiting up to
    // 2 minutes for its real schedule.
    await triggerBatchOptimization({
      tripId: tripId as string,
      journeyId: journeyId(driverUid),
      driverId: driverUid,
    });

    await expect(requestedCard(passengerPage).getByText('Pickup arranged')).toBeVisible({
      timeout: 30_000,
    });

    const trips = await tripsOf(passengerUid);
    const trip = trips[0];
    expect(trip?.fields.status?.stringValue).toBe('PICKUP_ASSIGNED');
    expect(trip?.fields.matchedDriverId?.stringValue).toBe(driverUid);
    expect(trip?.fields.matchedJourneyId?.stringValue).toBe(journeyId(driverUid));

    // Module 7.3: the passenger sees the matched driver's first name and vehicle, copied onto the
    // trip request at the same moment as matchedDriverId (no read access to the driver's own profile).
    expect(trip?.fields.driverName?.stringValue).toBe('Dan');
    expect(trip?.fields.vehicleMake?.stringValue).toBe('Toyota');
    await expect(requestedCard(passengerPage).getByText('Dan')).toBeVisible();
    await expect(requestedCard(passengerPage).getByText('Car Toyota Corolla')).toBeVisible();

    const journey = await readDriverJourney(driverUid);
    expect(journey?.status).toBe('MATCHING');

    // Module 7.1/7.2: the driver's Home shows the matched passenger, and can move the request on
    // through two manual actions of their own (no GPS/automatic inference, per user decision).
    const passengersCard = driverPage.getByLabel('Your passengers', { exact: true });
    await expect(passengersCard).toBeVisible({ timeout: 30_000 });
    await expect(passengersCard.getByText('Pick up Pat')).toBeVisible();

    await passengersCard.getByRole('button', { name: 'Head to pickup' }).click();
    await expect(requestedCard(passengerPage).getByText('Your driver is on the way')).toBeVisible({
      timeout: 15_000,
    });

    await passengersCard.getByRole('button', { name: 'Confirm pickup' }).click();
    await expect(requestedCard(passengerPage).getByText('You are on board')).toBeVisible({
      timeout: 15_000,
    });

    const pickedUpTrip = (await tripsOf(passengerUid))[0];
    expect(pickedUpTrip?.fields.status?.stringValue).toBe('PICKED_UP');

    // Module 7.4: the journey itself becomes ACTIVE on this first confirmed pickup.
    expect((await readDriverJourney(driverUid))?.status).toBe('ACTIVE');

    await passengersCard.getByRole('button', { name: 'Start trip' }).click();
    await expect(
      requestedCard(passengerPage).getByRole('heading', { name: 'On your way' }),
    ).toBeVisible({
      timeout: 15_000,
    });

    const inTransitTrip = (await tripsOf(passengerUid))[0];
    expect(inTransitTrip?.fields.status?.stringValue).toBe('IN_TRANSIT');

    await passengersCard.getByRole('button', { name: 'Approaching drop-off' }).click();
    await expect(
      requestedCard(passengerPage).getByRole('heading', { name: 'Almost there' }),
    ).toBeVisible({
      timeout: 15_000,
    });

    await passengersCard.getByRole('button', { name: 'Complete drop-off' }).click();

    // Module 7.5: completing the last dropoff completes the journey, frees the driver to start a new
    // one, and clears the passenger's own pointer so Home returns to "Request ride" on its own.
    await expect(requestRide(passengerPage)).toBeVisible({ timeout: 15_000 });
    await expect(requestedCard(passengerPage)).toHaveCount(0);

    const completedTrip = (await tripsOf(passengerUid))[0];
    expect(completedTrip?.fields.status?.stringValue).toBe('COMPLETED');

    // The journey's own pointer (drivers/{uid}.currentJourneyId) is cleared on completion, so it must
    // be read directly by id, not through readDriverJourney.
    expect(await readJourneyStatus(journeyId(driverUid))).toBe('COMPLETED');
    expect((await readDriverJourney(driverUid))?.id).toBeUndefined();

    await driverContext.close();
    await passengerContext.close();
  });
});
