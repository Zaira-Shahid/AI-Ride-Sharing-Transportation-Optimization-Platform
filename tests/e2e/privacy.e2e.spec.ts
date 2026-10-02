import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  apiKey,
  apps,
  authEmulator,
  createAccount,
  firestoreDocs,
  openLogin,
  submitLogin,
  uniqueEmail,
  writeDriverDoc,
} from './helpers';

// Phase 14 (Privacy compliance): the "Privacy and data" section on the Profile tab of the passenger app
// and of the driver app, driving the real export and deletion callables (functions/src/dataRights.ts
// and driverDataRights.ts) through the real Expo web builds.
// Passenger app only: the driver app has no such section yet.

const [passengerApp, driverApp] = apps;

const HOME = { latitude: 51.5, longitude: -0.1, formattedAddress: '1 Home Street, London' };
const OFFICE = { latitude: 51.6, longitude: -0.2, formattedAddress: '2 Office Road, London' };

const place = (p: typeof HOME) => ({
  mapValue: {
    fields: {
      latitude: { doubleValue: p.latitude },
      longitude: { doubleValue: p.longitude },
      formattedAddress: { stringValue: p.formattedAddress },
    },
  },
});

/** Writes a trip request for a passenger the way the server would, with the emulator owner token. */
async function seedTrip(passengerId: string, status: string): Promise<string> {
  const now = new Date().toISOString();
  const response = await fetch(`${firestoreDocs}/tripRequests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({
      fields: {
        passengerId: { stringValue: passengerId },
        passengerName: { stringValue: 'Ada' },
        status: { stringValue: status },
        origin: place(HOME),
        destination: place(OFFICE),
        paymentStatus: { nullValue: null },
        finalFareMinorUnits: { integerValue: '1250' },
        createdAt: { timestampValue: now },
        updatedAt: { timestampValue: now },
      },
    }),
  });
  expect(response.ok).toBe(true);
  const { name } = (await response.json()) as { name: string };
  return name.split('/documents/')[1] ?? '';
}

async function readDoc(path: string) {
  const response = await fetch(`${firestoreDocs}/${path}`, {
    headers: { authorization: 'Bearer owner' },
  });
  if (response.status === 404) return null;
  const { fields } = (await response.json()) as {
    fields: Record<string, { stringValue?: string; nullValue?: null; mapValue?: unknown }>;
  };
  return fields;
}

async function setTripStatus(path: string, status: string) {
  const response = await fetch(`${firestoreDocs}/${path}?updateMask.fieldPaths=status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({ fields: { status: { stringValue: status } } }),
  });
  expect(response.ok).toBe(true);
}

/** Whether the Auth emulator still knows this account (a password sign-in either works or does not). */
async function accountExists(email: string) {
  const response = await fetch(
    `${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    },
  );
  return response.ok;
}

async function signedInPassenger(page: Page, prefix: string) {
  const email = uniqueEmail(prefix);
  const uid = await createAccount(email, 'PASSENGER', true, 'Ada Lovelace', {
    name: 'Ada Lovelace',
    phone: null,
  });
  await openLogin(page, passengerApp.url, passengerApp.title);
  await submitLogin(page, email, PASSWORD);
  await expect(page.getByText(passengerApp.home)).toBeVisible();
  await page.getByRole('tab', { name: 'Profile' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
  return { email, uid };
}

const startDeletion = async (page: Page) => {
  await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Delete your account?' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
};

const typeDelete = (page: Page, word = 'DELETE') =>
  page.getByLabel('Type DELETE to confirm', { exact: true }).fill(word);

test.describe('passenger privacy and data', () => {
  test('explains what is kept and removed', async ({ page }) => {
    await signedInPassenger(page, 'privacy-notes');
    await expect(page.getByRole('heading', { name: 'Privacy and data' })).toBeVisible();
    await expect(page.getByText(/removed 30 days after the ride ends/)).toBeVisible();
    await expect(page.getByText(/kept without your name/)).toBeVisible();
  });

  test('downloads the passenger own data as a file', async ({ page }) => {
    const { email, uid } = await signedInPassenger(page, 'privacy-export');
    const tripPath = await seedTrip(uid, 'COMPLETED');

    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download my data', exact: true }).click();
    const download = await downloading;

    expect(download.suggestedFilename()).toMatch(/^ridemesh-my-data-\d{4}-\d{2}-\d{2}\.json$/);
    const saved = await download.path();
    const data = JSON.parse(await readFile(saved, 'utf-8')) as {
      profile: { email: string; name: string };
      trips: { tripId: string; status: string }[];
    };
    expect(data.profile).toMatchObject({ email, name: 'Ada Lovelace' });
    expect(data.trips).toEqual([
      expect.objectContaining({ tripId: tripPath.split('/')[1], status: 'COMPLETED' }),
    ]);
    await expect(page.getByText('Your data was downloaded as a file.')).toBeVisible();
    // Downloading deletes nothing.
    await expect(page.getByText('Signed in as')).toBeVisible();
  });

  test('deletion needs the typed word, and cancelling changes nothing', async ({ page }) => {
    const { email, uid } = await signedInPassenger(page, 'privacy-cancel');

    // Cancelling at the first step.
    await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Delete your account?' })).toHaveCount(0);
    await expect(page.getByLabel('Type DELETE to confirm', { exact: true })).toHaveCount(0);

    // At the typing step the button stays off until the exact word is typed.
    await startDeletion(page);
    const final = page.getByRole('button', { name: 'Permanently delete my account', exact: true });
    await expect(final).toBeDisabled();
    await typeDelete(page, 'delete');
    await expect(final).toBeDisabled();
    await typeDelete(page, 'DELETE');
    await expect(final).toBeEnabled();

    // Cancelling there leaves the account alone.
    await page.getByRole('button', { name: 'Cancel deletion', exact: true }).click();
    await expect(page.getByLabel('Type DELETE to confirm', { exact: true })).toHaveCount(0);
    expect(await readDoc(`users/${uid}`)).not.toBeNull();
    expect(await accountExists(email)).toBe(true);
    await expect(page.getByText('Signed in as')).toBeVisible();
  });

  test('is refused while a ride is open, and nothing is deleted', async ({ page }) => {
    const { email, uid } = await signedInPassenger(page, 'privacy-open-ride');
    const tripPath = await seedTrip(uid, 'SEARCHING');
    try {
      await startDeletion(page);
      await typeDelete(page);
      await page
        .getByRole('button', { name: 'Permanently delete my account', exact: true })
        .click();

      await expect(
        page.getByText('Finish or cancel your current ride before deleting your account.'),
      ).toBeVisible();
      // Still signed in, still on the profile, nothing changed on the server.
      await expect(page.getByText('Signed in as')).toBeVisible();
      expect(await readDoc(`users/${uid}`)).not.toBeNull();
      expect(await accountExists(email)).toBe(true);
      expect((await readDoc(tripPath))?.passengerId?.stringValue).toBe(uid);
    } finally {
      // No in-flight request left behind for the shared emulator's batch runs.
      await setTripStatus(tripPath, 'CANCELLED');
    }
  });

  test('deletes the account, anonymizes the rides and lands on the welcome screen', async ({
    page,
  }) => {
    const { email, uid } = await signedInPassenger(page, 'privacy-delete');
    const tripPath = await seedTrip(uid, 'COMPLETED');

    await startDeletion(page);
    await typeDelete(page);
    await page.getByRole('button', { name: 'Permanently delete my account', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: passengerApp.title })).toBeVisible();
    await expect(page.getByText('Signed in as')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Profile' })).toHaveCount(0);

    expect(await readDoc(`users/${uid}`)).toBeNull();
    expect(await accountExists(email)).toBe(false);

    const trip = await readDoc(tripPath);
    expect(trip?.passengerId).toEqual({ nullValue: null });
    expect(trip?.passengerName?.stringValue).toBe('Deleted passenger');
    expect(trip?.origin).toEqual({ nullValue: null });
    expect(trip?.destination).toEqual({ nullValue: null });
    expect(trip?.status?.stringValue).toBe('COMPLETED');

    // A reload does not bring the deleted account's session back.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  });
});

// ---- The driver app: the same section, with the driver's own wording and rules. ----

const DRIVER_PLATE = 'E2E 4242';

/** A vehicle for the driver, written the way the server does, with the emulator owner token. */
async function seedVehicle(driverId: string) {
  const now = new Date().toISOString();
  const text = (value: string) => ({ stringValue: value });
  const response = await fetch(`${firestoreDocs}/vehicles/${driverId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({
      fields: {
        driverId: text(driverId),
        type: text('CAR'),
        make: text('Toyota'),
        model: text('Prius'),
        plateNumber: text(DRIVER_PLATE),
        plateKey: text(DRIVER_PLATE.replace(/[\s-]/g, '')),
        seatCapacity: { integerValue: '3' },
        availableSeats: { integerValue: '3' },
        verificationStatus: text('PENDING'),
        verificationReason: { nullValue: null },
        verificationReviewedAt: { nullValue: null },
        createdAt: { timestampValue: now },
        updatedAt: { timestampValue: now },
      },
    }),
  });
  expect(response.ok).toBe(true);
}

/** A ride this driver drove, with a passenger whose name and places must never reach the driver. */
async function seedDrivenTrip(driverId: string): Promise<string> {
  const now = new Date().toISOString();
  const text = (value: string) => ({ stringValue: value });
  const response = await fetch(`${firestoreDocs}/tripRequests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({
      fields: {
        passengerId: text(`e2e-passenger-of-${driverId}`),
        passengerName: text('Zelda'),
        matchedDriverId: text(driverId),
        driverName: text('Grace'),
        vehiclePlateNumber: text(DRIVER_PLATE),
        status: text('COMPLETED'),
        origin: place(HOME),
        destination: place(OFFICE),
        paymentStatus: { nullValue: null },
        finalFareMinorUnits: { integerValue: '1250' },
        createdAt: { timestampValue: now },
        updatedAt: { timestampValue: now },
      },
    }),
  });
  expect(response.ok).toBe(true);
  const { name } = (await response.json()) as { name: string };
  return name.split('/documents/')[1] ?? '';
}

async function signedInDriver(page: Page, prefix: string) {
  const email = uniqueEmail(prefix);
  const uid = await createAccount(email, 'DRIVER', true, 'Grace Hopper', {
    name: 'Grace Hopper',
    phone: null,
  });
  await seedVehicle(uid);
  await openLogin(page, driverApp.url, driverApp.title);
  await submitLogin(page, email, PASSWORD);
  await expect(page.getByText(driverApp.home)).toBeVisible();
  await page.getByRole('tab', { name: 'Profile' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
  return { email, uid };
}

test.describe('driver privacy and data', () => {
  test('explains what is kept and removed, in the drivers own words', async ({ page }) => {
    await signedInDriver(page, 'privacy-driver-notes');
    await expect(page.getByRole('heading', { name: 'Privacy and data' })).toBeVisible();
    await expect(page.getByText(/including the number plate/)).toBeVisible();
    await expect(page.getByText(/earnings records are kept without your name/)).toBeVisible();
    await expect(page.getByText(/online or a ride is in progress/)).toBeVisible();
    // The passenger's wording does not leak across.
    await expect(page.getByText(/saved card/)).toHaveCount(0);
    await expect(page.getByText(/30 days/)).toHaveCount(0);
  });

  test('downloads the driver own data, without any passenger', async ({ page }) => {
    const { email, uid } = await signedInDriver(page, 'privacy-driver-export');
    const tripPath = await seedDrivenTrip(uid);

    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download my data', exact: true }).click();
    const download = await downloading;

    expect(download.suggestedFilename()).toMatch(/^ridemesh-my-data-\d{4}-\d{2}-\d{2}\.json$/);
    const text = await readFile(await download.path(), 'utf-8');
    const data = JSON.parse(text) as {
      profile: { email: string; name: string };
      vehicle: { plateNumber: string; make: string } | null;
      trips: { tripId: string; status: string }[];
    };
    expect(data.profile).toMatchObject({ email, name: 'Grace Hopper' });
    expect(data.vehicle).toMatchObject({ plateNumber: DRIVER_PLATE, make: 'Toyota' });
    expect(data.trips).toEqual([
      expect.objectContaining({ tripId: tripPath.split('/')[1], status: 'COMPLETED' }),
    ]);
    // What the driver did, never who rode.
    expect(text).not.toContain('Zelda');
    expect(text).not.toContain(HOME.formattedAddress);
    await expect(page.getByText('Your data was downloaded as a file.')).toBeVisible();
    await expect(page.getByText('Signed in as')).toBeVisible();
  });

  test('is refused while the driver is online, and nothing is deleted', async ({ page }) => {
    const { email, uid } = await signedInDriver(page, 'privacy-driver-online');
    await writeDriverDoc(uid, { availabilityStatus: 'ONLINE', verificationStatus: 'VERIFIED' });

    await startDeletion(page);
    await typeDelete(page);
    await page.getByRole('button', { name: 'Permanently delete my account', exact: true }).click();

    await expect(page.getByText('Go offline before deleting your account.')).toBeVisible();
    await expect(page.getByText('Signed in as')).toBeVisible();
    expect(await readDoc(`users/${uid}`)).not.toBeNull();
    expect(await readDoc(`drivers/${uid}`)).not.toBeNull();
    expect(await readDoc(`vehicles/${uid}`)).not.toBeNull();
    expect(await accountExists(email)).toBe(true);
  });

  test('deletes the account, takes the driver out of the ride and lands on the welcome screen', async ({
    page,
  }) => {
    const { email, uid } = await signedInDriver(page, 'privacy-driver-delete');
    const tripPath = await seedDrivenTrip(uid);

    await startDeletion(page);
    await typeDelete(page);
    await page.getByRole('button', { name: 'Permanently delete my account', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: driverApp.title })).toBeVisible();
    await expect(page.getByText('Signed in as')).toHaveCount(0);

    expect(await readDoc(`users/${uid}`)).toBeNull();
    expect(await readDoc(`drivers/${uid}`)).toBeNull();
    expect(await readDoc(`vehicles/${uid}`)).toBeNull();
    expect(await accountExists(email)).toBe(false);

    // The ride stays, with the driver gone from it and the passenger's side untouched.
    const trip = await readDoc(tripPath);
    expect(trip?.matchedDriverId).toEqual({ nullValue: null });
    expect(trip?.driverName).toEqual({ nullValue: null });
    expect(trip?.vehiclePlateNumber).toEqual({ nullValue: null });
    expect(trip?.status?.stringValue).toBe('COMPLETED');
    expect(trip?.passengerName?.stringValue).toBe('Zelda');
    expect(trip?.origin).not.toEqual({ nullValue: null });

    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  });
});
