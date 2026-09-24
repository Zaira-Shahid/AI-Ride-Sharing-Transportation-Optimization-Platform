import { expect, test, type Page } from '@playwright/test';
import { NEW_TRIP_REQUEST_DEFAULTS } from '@ridemesh/types';
import { defaultRouteBody } from '../fake-osrm';
import { PLACES, firestoreDocs, mockPlaces } from './helpers';
import { newPassenger, watchMap } from './map-helpers';
import {
  chooseDestination,
  choosePickup,
  confirm,
  requestRide,
  requestedCard,
  reviewCard,
} from './trip-helpers';

// Phase 3 acceptance (spec: "Passenger can create a complete request"). One passenger builds a
// request the way a person would, with every choice changed from its default: a place to go to, a
// place to be picked up at, a departure time, an arrival time, and a flexibility level with sharing
// switched off. Then the request is read back from the database, with the emulator's owner token, to
// see that exactly that was stored, and nothing more: no fare, no route, no driver.

const { office, station } = PLACES;

test.use({ locale: 'en-GB', timezoneId: 'Europe/London' });

const timeCard = (page: Page) => page.getByLabel('When', { exact: true });
const flexCard = (page: Page) => page.getByLabel('Flexibility', { exact: true });
const chip = (page: Page, groupName: string, name: string) =>
  timeCard(page).getByRole('radiogroup', { name: groupName, exact: true }).getByRole('radio', {
    name,
    exact: true,
  });

type Value = Record<string, unknown>;

/** Turns a Firestore REST value into a plain one, so the test reads what the database holds. */
function decode(value: Value): unknown {
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('doubleValue' in value) return value.doubleValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('timestampValue' in value) return Date.parse(String(value.timestampValue));
  if ('nullValue' in value) return null;
  if ('mapValue' in value) {
    const { fields = {} } = value.mapValue as { fields?: Record<string, Value> };
    return Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, decode(item)]));
  }
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}

async function storedRequests(uid: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${firestoreDocs}/tripRequests?pageSize=300`, {
    headers: { authorization: 'Bearer owner' },
  });
  const { documents = [] } = (await response.json()) as {
    documents?: { fields: Record<string, Value> }[];
  };
  return documents
    .map((document) => decode({ mapValue: { fields: document.fields } }) as Record<string, unknown>)
    .filter((trip) => trip.passengerId === uid);
}

async function storedUser(uid: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${firestoreDocs}/users/${uid}`, {
    headers: { authorization: 'Bearer owner' },
  });
  const { fields } = (await response.json()) as { fields: Record<string, Value> };
  return decode({ mapValue: { fields } }) as Record<string, unknown>;
}

const londonHour = (at: number) =>
  Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone: 'Europe/London',
    }).format(at),
  );

test.describe('phase 3 acceptance: a passenger creates a complete request', () => {
  test('builds a request with every choice changed, and stores exactly that', async ({ page }) => {
    await mockPlaces(page);
    await watchMap(page);
    const { uid } = await newPassenger(page, 'phase3');
    const before = Date.now();

    // Where to, and where from.
    await chooseDestination(page, 'canary', office.text);
    await choosePickup(page, 'temple', station.text);

    // When: leave tomorrow at 10, arrive by 12 (tomorrow is always inside the 5 minutes to 7 days
    // that can be chosen, so the test does not depend on the time of day it runs).
    await timeCard(page).getByRole('button', { name: 'Change times' }).click();
    await timeCard(page).getByRole('radio', { name: 'Pick a time', exact: true }).click();
    await chip(page, 'Leave at: day', 'Tomorrow').click();
    await chip(page, 'Leave at: hour', '10').click();
    await timeCard(page).getByRole('radio', { name: 'Arrive by a time', exact: true }).click();
    await chip(page, 'Arrive by: day', 'Tomorrow').click();
    await chip(page, 'Arrive by: hour', '12').click();
    await timeCard(page).getByRole('button', { name: 'Done' }).click();

    // How flexible: Strict, and not sharing the ride.
    await flexCard(page).getByRole('button', { name: 'Change flexibility' }).click();
    await flexCard(page).getByRole('radio', { name: 'Strict', exact: true }).click();
    await flexCard(page).getByRole('switch', { name: 'Share my ride', exact: true }).click();
    await flexCard(page).getByRole('button', { name: 'Done' }).click();

    // Nothing has been stored yet: the request exists only on the screen.
    expect(await storedRequests(uid)).toHaveLength(0);
    expect((await storedUser(uid)).currentTripRequestId ?? null).toBeNull();

    // The review says what will be sent.
    await requestRide(page).click();
    await expect(reviewCard(page)).toBeVisible();
    await expect(reviewCard(page).getByText(station.address)).toBeVisible();
    await expect(reviewCard(page).getByText(office.address)).toBeVisible();
    await expect(reviewCard(page).getByText(/^Tomorrow, 10:\d\d$/)).toBeVisible();
    await expect(reviewCard(page).getByText(/^Tomorrow, 12:\d\d$/)).toBeVisible();
    await expect(reviewCard(page).getByText('Strict, not sharing', { exact: true })).toBeVisible();
    expect(await storedRequests(uid)).toHaveLength(0);

    await confirm(page).click();
    await expect(requestedCard(page)).toBeVisible();
    await expect(
      requestedCard(page).getByRole('heading', { name: 'Ride requested' }),
    ).toBeVisible();
    const after = Date.now();

    const [trip, ...others] = await storedRequests(uid);
    expect(others).toEqual([]);
    if (!trip) throw new Error('The request was not stored.');

    // The places, exactly as chosen.
    expect(trip.origin).toEqual({
      latitude: station.latitude,
      longitude: station.longitude,
      formattedAddress: station.address,
      placeId: station.id,
    });
    expect(trip.destination).toEqual({
      latitude: office.latitude,
      longitude: office.longitude,
      formattedAddress: office.address,
      placeId: office.id,
    });

    // The times: the server's own stamp for when it was asked, and the two times chosen, as instants.
    const requestedAt = trip.requestedAt as number;
    expect(requestedAt).toBeGreaterThanOrEqual(before - 60_000);
    expect(requestedAt).toBeLessThanOrEqual(after + 60_000);
    const departure = trip.requestedDepartureTime as number;
    const arrival = trip.arrivalDeadline as number;
    expect(londonHour(departure)).toBe(10);
    expect(londonHour(arrival)).toBe(12);
    expect(departure).toBeGreaterThan(requestedAt + 5 * 60_000);
    expect(departure).toBeLessThanOrEqual(requestedAt + 7 * 24 * 60 * 60_000);
    expect(arrival - departure).toBeGreaterThan(60 * 60_000);
    expect(arrival - departure).toBeLessThan(3 * 60 * 60_000);

    // The flexibility: Strict's own numbers, with sharing off and route changes as Strict has them.
    expect(trip.passengerPreferences).toEqual({
      flexibilityLevel: 'STRICT',
      maxWalkingDistance: 200,
      maxExtraTime: 5,
      maxDetourDistance: 1,
      allowSharedRide: false,
      allowRouteChange: false,
    });

    // Where it stands, and what is not known yet: no fare, driver or plan.
    // The search-starting trigger (Modules 5.2 and 5.3) moves every request on to SEARCHING moments
    // after creation, future-dated ones included (they get no candidates yet, but still move on).
    expect(['REQUESTED', 'SEARCHING']).toContain(trip.status);
    expect(trip.estimatedFare).toBeNull();
    expect(trip.assignedPlanId).toBeNull();
    // The distance and time of the trip are worked out by the server a moment after the request is
    // made (Modules 4.4 and 4.5): metres and whole seconds, for the two places as the fake route server
    // sees them (rounded to about 11 m).
    await expect
      .poll(async () => (await storedRequests(uid))[0]?.estimatedDistance, { timeout: 20_000 })
      .not.toBeNull();
    const [estimated] = await storedRequests(uid);
    const expectedRoute = defaultRouteBody({
      stops: [
        { latitude: station.latitude, longitude: station.longitude },
        { latitude: office.latitude, longitude: office.longitude },
      ],
    }).routes[0];
    expect(estimated?.estimatedDistance).toBe(Math.round(expectedRoute?.distance ?? Number.NaN));
    expect(estimated?.estimatedDuration).toBe(Math.round(expectedRoute?.duration ?? Number.NaN));
    expect(typeof trip.createdAt).toBe('number');
    expect(typeof trip.updatedAt).toBe('number');
    // The fields the passenger's own input always fills in at creation (tripRequests.ts's tx.create),
    // plus every field NEW_TRIP_REQUEST_DEFAULTS adds (self-updating: a field added there, the one
    // place a new module's own default belongs, is picked up here automatically - no separate list to
    // remember to update, unlike the hand-maintained one this replaced).
    const ALWAYS_PRESENT_ON_CREATE = [
      'passengerId',
      'passengerName',
      'origin',
      'destination',
      'requestedAt',
      'requestedDepartureTime',
      'arrivalDeadline',
      'passengerPreferences',
      'createdAt',
      'updatedAt',
    ];
    expect(Object.keys(trip).sort()).toEqual(
      [...ALWAYS_PRESENT_ON_CREATE, ...Object.keys(NEW_TRIP_REQUEST_DEFAULTS)].sort(),
    );

    // And the passenger's account points at it, so a reload finds it again.
    expect(typeof (await storedUser(uid)).currentTripRequestId).toBe('string');
    await page.reload();
    await expect(requestedCard(page)).toBeVisible();
    await expect(requestedCard(page).getByText('Strict, not sharing')).toBeVisible();
  });
});
