import type { Page } from '@playwright/test';
import { PLACES, firestoreDocs, mockPlaces } from './helpers';
import { newPassenger, watchMap } from './map-helpers';

const { office, station } = PLACES;

export const pickupCard = (page: Page) => page.getByLabel('Pickup', { exact: true });
export const destinationCard = (page: Page) => page.getByLabel('Where to', { exact: true });
export const reviewCard = (page: Page) =>
  page.getByLabel('Review your ride request', { exact: true });
export const requestedCard = (page: Page) => page.getByLabel('Ride requested', { exact: true });
export const requestRide = (page: Page) =>
  page.getByRole('button', { name: 'Request ride', exact: true });
export const confirm = (page: Page) =>
  page.getByRole('button', { name: 'Confirm ride request', exact: true });
export const cancelRequest = (page: Page) =>
  page.getByRole('button', { name: 'Cancel ride request', exact: true });

export async function chooseDestination(page: Page, query: string, text: string) {
  await page.getByLabel('Search for a destination').fill(query);
  await destinationCard(page).getByRole('button', { name: text }).click();
}

export async function choosePickup(page: Page, query: string, text: string) {
  await page.getByLabel('Search for a pickup').fill(query);
  await pickupCard(page).getByRole('button', { name: text }).click();
}

/** A passenger with both places chosen, ready to request a ride. */
export async function readyToRequest(page: Page, prefix: string) {
  await mockPlaces(page);
  const watch = await watchMap(page);
  const { uid } = await newPassenger(page, prefix);
  await chooseDestination(page, 'canary', office.text);
  await choosePickup(page, 'temple', station.text);
  return { uid, watch };
}

export interface StoredTrip {
  name: string;
  fields: Record<string, { stringValue?: string; nullValue?: null; timestampValue?: string }>;
}

/** The trip requests stored for a passenger, read with the emulator owner token. */
export async function tripsOf(uid: string): Promise<StoredTrip[]> {
  const response = await fetch(`${firestoreDocs}/tripRequests?pageSize=300`, {
    headers: { authorization: 'Bearer owner' },
  });
  const { documents = [] } = (await response.json()) as { documents?: StoredTrip[] };
  return documents.filter((trip) => trip.fields.passengerId?.stringValue === uid);
}

export const statusOf = (trip: StoredTrip | undefined) => trip?.fields.status?.stringValue;

/**
 * Changes a stored request's status, as the matching modules will do on the server. Nothing in the
 * app can do this yet, so the emulator's owner token is used, which bypasses the rules.
 */
export async function setTripStatus(trip: StoredTrip, status: string) {
  const path = trip.name.split('/documents/')[1];
  const response = await fetch(`${firestoreDocs}/${path}?updateMask.fieldPaths=status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({ fields: { status: { stringValue: status } } }),
  });
  if (!response.ok) throw new Error(`Could not set the status: ${response.status}`);
}
