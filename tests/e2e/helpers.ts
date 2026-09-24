import { expect, type Page } from '@playwright/test';
import { TEST_PORTS } from '../test-ports';

export const projectId = 'demo-ridemesh';
export const authEmulator = `http://127.0.0.1:${TEST_PORTS.auth}`;
export const apiKey = 'e2e-api-key';
export const PASSWORD = 'correct-horse-battery';

export const apps = [
  {
    name: 'passenger',
    url: `http://localhost:${TEST_PORTS.passenger}`,
    title: 'RideMesh',
    role: 'PASSENGER',
    home: 'Where are you going?',
    otherRole: 'DRIVER',
    mismatch: 'This is a driver account. Please sign in with the RideMesh Driver app.',
  },
  {
    name: 'driver',
    url: `http://localhost:${TEST_PORTS.driver}`,
    title: 'RideMesh Driver',
    role: 'DRIVER',
    home: 'You are offline',
    otherRole: 'PASSENGER',
    mismatch: 'This is a passenger account. Please sign in with the RideMesh app.',
  },
] as const;

let counter = 0;
export const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${counter++}@example.test`;

/** Creates an account directly in the Auth emulator, with a server-style role claim. */
export async function createAccount(
  email: string,
  role: string | null,
  verified: boolean,
  displayName?: string,
  profile?: { name: string; phone: string | null },
) {
  const signUp = await fetch(
    `${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    },
  );
  const { localId } = (await signUp.json()) as { localId: string };
  const update = await fetch(
    `${authEmulator}/identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:update`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({
        localId,
        emailVerified: verified,
        customAttributes: JSON.stringify(role ? { role } : {}),
        ...(displayName ? { displayName } : {}),
      }),
    },
  );
  expect(update.ok).toBe(true);
  if (profile && role) {
    await createProfileDoc(localId, { role, email, ...profile });
    if (role === 'DRIVER') await writeDriverDoc(localId);
  }
  return localId;
}

export const firestoreDocs = `http://127.0.0.1:${TEST_PORTS.firestore}/v1/projects/${projectId}/databases/(default)/documents`;

/** Writes users/{uid} the way the server does, bypassing rules with the emulator owner token. */
async function createProfileDoc(
  uid: string,
  profile: { role: string; email: string; name: string; phone: string | null },
) {
  const now = new Date().toISOString();
  const response = await fetch(`${firestoreDocs}/users?documentId=${uid}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({
      fields: {
        role: { stringValue: profile.role },
        name: { stringValue: profile.name },
        email: { stringValue: profile.email },
        phone: profile.phone ? { stringValue: profile.phone } : { nullValue: null },
        photoUrl: { nullValue: null },
        status: { stringValue: 'ACTIVE' },
        createdAt: { timestampValue: now },
        updatedAt: { timestampValue: now },
      },
    }),
  });
  expect(response.ok).toBe(true);
}

interface DriverDocFields {
  availabilityStatus?: string;
  currentJourneyId?: string | null;
  verificationStatus?: string;
  verificationReason?: string | null;
  totalTrips?: number;
  rating?: number | null;
}

/** Writes drivers/{uid} the way the server does (replacing it), bypassing rules with the owner token. */
export async function writeDriverDoc(uid: string, fields: DriverDocFields = {}) {
  const now = new Date().toISOString();
  const rating = fields.rating ?? null;
  const response = await fetch(`${firestoreDocs}/drivers/${uid}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({
      fields: {
        userId: { stringValue: uid },
        verificationStatus: { stringValue: fields.verificationStatus ?? 'PENDING' },
        verificationReason:
          fields.verificationReason == null
            ? { nullValue: null }
            : { stringValue: fields.verificationReason },
        verificationReviewedAt: { nullValue: null },
        availabilityStatus: { stringValue: fields.availabilityStatus ?? 'OFFLINE' },
        rating: rating === null ? { nullValue: null } : { doubleValue: rating },
        totalTrips: { integerValue: String(fields.totalTrips ?? 0) },
        maxDetourMinutes: { nullValue: null },
        maxDetourDistance: { nullValue: null },
        automaticMatchingEnabled: { nullValue: null },
        currentJourneyId:
          fields.currentJourneyId == null
            ? { nullValue: null }
            : { stringValue: fields.currentJourneyId },
        createdAt: { timestampValue: now },
        updatedAt: { timestampValue: now },
      },
    }),
  });
  expect(response.ok).toBe(true);
}

/** Removes drivers/{uid}, as if the account had registered before driver profiles existed. */
export async function deleteDriverDoc(uid: string) {
  const response = await fetch(`${firestoreDocs}/drivers/${uid}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer owner' },
  });
  expect(response.ok).toBe(true);
}

/** What is stored in users/{uid}, read with the emulator owner token. */
export async function readProfileDoc(uid: string) {
  const response = await fetch(`${firestoreDocs}/users/${uid}`, {
    headers: { authorization: 'Bearer owner' },
  });
  const { fields } = (await response.json()) as {
    fields: Record<string, { stringValue?: string; nullValue?: null }>;
  };
  return {
    name: fields.name?.stringValue,
    phone: fields.phone?.stringValue ?? null,
    role: fields.role?.stringValue,
  };
}

export async function openLogin(page: Page, url: string, title: string) {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
}

export async function submitLogin(page: Page, email: string, password: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** The most recent password reset code the Auth emulator issued for an address, if any. */
export async function resetCodeFor(email: string) {
  const response = await fetch(`${authEmulator}/emulator/v1/projects/${projectId}/oobCodes`);
  const { oobCodes } = (await response.json()) as {
    oobCodes: { email: string; oobCode: string; requestType: string }[];
  };
  return oobCodes
    .filter((entry) => entry.email === email && entry.requestType === 'PASSWORD_RESET')
    .at(-1)?.oobCode;
}

/** What Firebase's hosted page does when a person picks a new password. */
export async function chooseNewPassword(oobCode: string, newPassword: string) {
  const response = await fetch(
    `${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oobCode, newPassword }),
    },
  );
  expect(response.ok).toBe(true);
}

let vehicleCounter = 0;

interface VehicleDocFields {
  type?: string;
  make?: string;
  model?: string;
  plateNumber?: string;
  seatCapacity?: number | null;
  verificationStatus?: string;
  verificationReason?: string | null;
}

/** Writes vehicles/{uid} the way the server does (replacing it), bypassing rules with the owner token. */
export async function writeVehicleDoc(uid: string, fields: VehicleDocFields = {}) {
  const now = new Date().toISOString();
  // Plate numbers are unique, so seeded vehicles get their own unless a test says otherwise.
  const plateNumber = fields.plateNumber ?? `SD${Date.now() % 1_000_000}${vehicleCounter++}`;
  const response = await fetch(`${firestoreDocs}/vehicles/${uid}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({
      fields: {
        driverId: { stringValue: uid },
        type: { stringValue: fields.type ?? 'CAR' },
        make: { stringValue: fields.make ?? 'Toyota' },
        model: { stringValue: fields.model ?? 'Corolla' },
        plateNumber: { stringValue: plateNumber },
        plateKey: { stringValue: plateNumber.replace(/[\s-]/g, '') },
        seatCapacity:
          fields.seatCapacity == null
            ? { nullValue: null }
            : { integerValue: String(fields.seatCapacity) },
        availableSeats: { nullValue: null },
        verificationStatus: { stringValue: fields.verificationStatus ?? 'PENDING' },
        verificationReason:
          fields.verificationReason == null
            ? { nullValue: null }
            : { stringValue: fields.verificationReason },
        verificationReviewedAt: { nullValue: null },
        createdAt: { timestampValue: now },
        updatedAt: { timestampValue: now },
      },
    }),
  });
  expect(response.ok).toBe(true);
}

/** What is stored in vehicles/{uid}, or undefined when there is none. */
export async function readVehicleDoc(uid: string) {
  const response = await fetch(`${firestoreDocs}/vehicles/${uid}`, {
    headers: { authorization: 'Bearer owner' },
  });
  if (response.status === 404) return undefined;
  const { fields } = (await response.json()) as {
    fields: Record<string, { stringValue?: string; integerValue?: string }>;
  };
  return {
    type: fields.type?.stringValue,
    make: fields.make?.stringValue,
    model: fields.model?.stringValue,
    plateNumber: fields.plateNumber?.stringValue,
    seatCapacity: fields.seatCapacity?.integerValue
      ? Number(fields.seatCapacity.integerValue)
      : null,
    verificationStatus: fields.verificationStatus?.stringValue,
    verificationReason: fields.verificationReason?.stringValue ?? null,
  };
}

/** verificationStatus and verificationReason stored in drivers/{uid}. */
export async function readDriverVerification(uid: string) {
  const response = await fetch(`${firestoreDocs}/drivers/${uid}`, {
    headers: { authorization: 'Bearer owner' },
  });
  const { fields } = (await response.json()) as {
    fields: Record<string, { stringValue?: string }>;
  };
  return {
    verificationStatus: fields.verificationStatus?.stringValue,
    verificationReason: fields.verificationReason?.stringValue ?? null,
  };
}

/** availabilityStatus stored in drivers/{uid}. */
export async function readDriverAvailability(uid: string) {
  const response = await fetch(`${firestoreDocs}/drivers/${uid}`, {
    headers: { authorization: 'Bearer owner' },
  });
  const { fields } = (await response.json()) as {
    fields: Record<string, { stringValue?: string }>;
  };
  return fields.availabilityStatus?.stringValue;
}

export const functionsUrl = `http://127.0.0.1:${TEST_PORTS.functions}/${projectId}/europe-west1`;

/** Signs in with the emulator's real auth REST API, the way the apps do, and returns the ID token. */
export async function signInIdToken(email: string, password: string = PASSWORD): Promise<string> {
  const response = await fetch(
    `${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { idToken } = (await response.json()) as { idToken: string };
  return idToken;
}

/**
 * Makes a staff decision the way the admin dashboard will: a real ADMIN account calls the real
 * reviewDriver or reviewVehicle function.
 */
export async function reviewAsAdmin(
  target: 'driver' | 'vehicle',
  driverId: string,
  decision: 'VERIFIED' | 'REJECTED',
  reason?: string,
) {
  const email = uniqueEmail('e2e-admin');
  await createAccount(email, 'ADMIN', true);
  const idToken = await signInIdToken(email);
  const response = await fetch(
    `${functionsUrl}/review${target === 'driver' ? 'Driver' : 'Vehicle'}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ data: { driverId, decision, ...(reason ? { reason } : {}) } }),
    },
  );
  expect(response.ok).toBe(true);
}

export interface Place {
  id: string;
  /** The line shown as a suggestion. */
  text: string;
  main: string;
  secondary: string;
  address: string;
  latitude: number;
  longitude: number;
}

export const PLACES = {
  office: {
    id: 'place-office',
    text: 'Canary Wharf, London, UK',
    main: 'Canary Wharf',
    secondary: 'London, UK',
    address: '1 Canada Square, London E14 5AB, UK',
    latitude: 51.5049,
    longitude: -0.0195,
  },
  station: {
    id: 'place-station',
    text: 'Temple Meads Station, Bristol, UK',
    main: 'Temple Meads Station',
    secondary: 'Bristol, UK',
    address: 'Temple Meads, Bristol BS1 6QS, UK',
    latitude: 51.4494,
    longitude: -2.5813,
  },
  // On the other side of the world from the others, for a trip with no service area.
  sydney: {
    id: 'place-sydney',
    text: 'Sydney Opera House, Sydney, Australia',
    main: 'Sydney Opera House',
    secondary: 'Sydney, Australia',
    address: 'Bennelong Point, Sydney NSW 2000, Australia',
    latitude: -33.8568,
    longitude: 151.2153,
  },
  // Well away from every other place here (Modules 5.2-5.5): a driver's journey a matching test
  // creates for itself must be the only one anywhere near its own pickup, whatever other tests have
  // left an AVAILABLE driver near the office/station route.
  farNorthStart: {
    id: 'place-far-north-start',
    text: 'Kelpie Point, UK',
    main: 'Kelpie Point',
    secondary: 'UK',
    address: 'Kelpie Point, UK',
    latitude: 58,
    longitude: -1,
  },
  farNorthEnd: {
    id: 'place-far-north-end',
    text: 'Thistle Point, UK',
    main: 'Thistle Point',
    secondary: 'UK',
    address: 'Thistle Point, UK',
    latitude: 58.05,
    longitude: -0.95,
  },
  // A position that was never filled in: exactly 0, 0. It passes the shape rules but is no place.
  nowhere: {
    id: 'place-nowhere',
    text: 'Middle of Nowhere, Atlantic Ocean',
    main: 'Middle of Nowhere',
    secondary: 'Atlantic Ocean',
    address: 'Somewhere in the Atlantic Ocean',
    latitude: 0,
    longitude: 0,
  },
  // 22 m north of the office: a different place, but the same place for a trip.
  neighbour: {
    id: 'place-neighbour',
    text: 'Reuters Plaza, London, UK',
    main: 'Reuters Plaza',
    secondary: 'London, UK',
    address: '30 South Colonnade, London E14 5EP, UK',
    latitude: 51.5051,
    longitude: -0.0195,
  },
  // 89 m north of the office: close, but far enough to be a different place for a trip.
  nearby: {
    id: 'place-nearby',
    text: 'Cabot Square, London, UK',
    main: 'Cabot Square',
    secondary: 'London, UK',
    address: 'Cabot Square, London E14 4QT, UK',
    latitude: 51.5057,
    longitude: -0.0195,
  },
} satisfies Record<string, Place>;

/** Where a journey written by writeJourneyDoc starts, unless it is told otherwise (Bristol). */
export const ORIGIN_POSITION = { latitude: 51.4494, longitude: -2.5813 };

const journeyIdOf = (uid: string) => `journey-${uid}`;
export { journeyIdOf as journeyId };

/**
 * Writes driverJourneys/journey-{uid} with a destination, the way the server does. The seats on
 * offer start as null, as they do on a new journey, unless a number is given.
 */
export async function writeJourneyDoc(
  uid: string,
  place: Place = PLACES.office,
  availableSeats: number | null = null,
  /** Extra minutes and kilometres the driver accepts; null (the default) means not chosen yet. */
  detour: { minutes: number; km: number } | null = null,
  /** Where the journey starts, as saved from the device (Module 4.1); null means not saved yet. */
  origin: { latitude: number; longitude: number } | null = ORIGIN_POSITION,
) {
  const now = new Date().toISOString();
  const response = await fetch(`${firestoreDocs}/driverJourneys/${journeyIdOf(uid)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({
      fields: {
        driverId: { stringValue: uid },
        vehicleId: { stringValue: uid },
        origin:
          origin === null
            ? { nullValue: null }
            : {
                mapValue: {
                  fields: {
                    latitude: { doubleValue: origin.latitude },
                    longitude: { doubleValue: origin.longitude },
                    formattedAddress: { stringValue: 'Current location' },
                    placeId: { nullValue: null },
                  },
                },
              },
        destination: {
          mapValue: {
            fields: {
              latitude: { doubleValue: place.latitude },
              longitude: { doubleValue: place.longitude },
              formattedAddress: { stringValue: place.address },
              placeId: { stringValue: place.id },
            },
          },
        },
        departureTime: { nullValue: null },
        availableSeats:
          availableSeats === null ? { nullValue: null } : { integerValue: String(availableSeats) },
        maxDetourMinutes:
          detour === null ? { nullValue: null } : { integerValue: String(detour.minutes) },
        maxDetourDistance:
          detour === null ? { nullValue: null } : { integerValue: String(detour.km) },
        status: { stringValue: 'DRAFT' },
        currentLocation: { nullValue: null },
        currentRoute: { nullValue: null },
        createdAt: { timestampValue: now },
        updatedAt: { timestampValue: now },
      },
    }),
  });
  expect(response.ok).toBe(true);
  return journeyIdOf(uid);
}

interface FirestoreValue {
  stringValue?: string;
  doubleValue?: number;
  integerValue?: string;
  mapValue?: { fields: Record<string, FirestoreValue> };
}

/**
 * A driverJourneys/{id} document's own status, read directly by id rather than through
 * drivers/{uid}.currentJourneyId - needed once a journey completes (Module 7.5), since completing it
 * clears that pointer so the driver can start a new one.
 */
export async function readJourneyStatus(id: string): Promise<string | undefined> {
  const response = await fetch(`${firestoreDocs}/driverJourneys/${id}`, {
    headers: { authorization: 'Bearer owner' },
  });
  if (response.status === 404) return undefined;
  const { fields } = (await response.json()) as { fields?: Record<string, FirestoreValue> };
  return fields?.status?.stringValue;
}

/** The driver's stored journey, found through drivers/{uid}.currentJourneyId, or undefined. */
export async function readDriverJourney(uid: string) {
  const headers = { authorization: 'Bearer owner' };
  const driverResponse = await fetch(`${firestoreDocs}/drivers/${uid}`, { headers });
  const driver = (await driverResponse.json()) as { fields?: Record<string, FirestoreValue> };
  const journeyId = driver.fields?.currentJourneyId?.stringValue;
  if (!journeyId) return undefined;

  const journeyResponse = await fetch(`${firestoreDocs}/driverJourneys/${journeyId}`, { headers });
  if (journeyResponse.status === 404) return undefined;
  const { fields } = (await journeyResponse.json()) as { fields: Record<string, FirestoreValue> };
  const place = fields.destination?.mapValue?.fields;
  const originFields = fields.origin?.mapValue?.fields;
  const locationFields = fields.currentLocation?.mapValue?.fields;
  const numberOf = (value: FirestoreValue | undefined) =>
    value?.doubleValue ??
    (value?.integerValue === undefined ? undefined : Number(value.integerValue));
  return {
    id: journeyId,
    driverId: fields.driverId?.stringValue,
    status: fields.status?.stringValue,
    availableSeats:
      fields.availableSeats?.integerValue === undefined
        ? null
        : Number(fields.availableSeats.integerValue),
    maxDetourMinutes:
      fields.maxDetourMinutes?.integerValue === undefined
        ? null
        : Number(fields.maxDetourMinutes.integerValue),
    maxDetourDistance:
      fields.maxDetourDistance?.integerValue === undefined
        ? null
        : Number(fields.maxDetourDistance.integerValue),
    /** Where the journey starts (Module 4.1), or null when it has not been saved. */
    origin: originFields
      ? {
          latitude: numberOf(originFields.latitude),
          longitude: numberOf(originFields.longitude),
          address: originFields.formattedAddress?.stringValue,
        }
      : null,
    /** The last position shared while online, or null when there is none. */
    currentLocation: locationFields
      ? {
          latitude: numberOf(locationFields.latitude),
          longitude: numberOf(locationFields.longitude),
        }
      : null,
    address: place?.formattedAddress?.stringValue,
    latitude: place?.latitude?.doubleValue,
    longitude: place?.longitude?.doubleValue,
    placeId: place?.placeId?.stringValue,
  };
}

export interface PlacesCall {
  kind: 'autocomplete' | 'details';
  apiKey: string | undefined;
  fieldMask: string | undefined;
  sessionToken: string | undefined;
  input?: string;
  placeId?: string;
}

export interface PlacesMock {
  calls: PlacesCall[];
  /** Make the next Places requests fail with this HTTP status; undefined answers normally again. */
  failWith: (status: number | undefined) => void;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

/**
 * Stands in for Google's Places API (New) in the browser, so no test reaches Google. It answers the
 * autocomplete and details requests the way Google documents them, from the PLACES above, and
 * records what was asked (key, field mask, session token) so tests can check the requests.
 */
export async function mockPlaces(page: Page): Promise<PlacesMock> {
  const calls: PlacesCall[] = [];
  let failure: number | undefined;

  await page.route('https://places.googleapis.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    if (failure !== undefined) {
      await route.fulfill({
        status: failure,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ error: { message: 'mocked failure' } }),
      });
      return;
    }

    const headers = request.headers();
    const url = new URL(request.url());
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    if (url.pathname === '/v1/places:autocomplete') {
      const body = request.postDataJSON() as { input: string; sessionToken: string };
      calls.push({
        kind: 'autocomplete',
        apiKey: headers['x-goog-api-key'],
        fieldMask: headers['x-goog-fieldmask'],
        sessionToken: body.sessionToken,
        input: body.input,
      });
      const needle = body.input.toLowerCase();
      const matches = Object.values(PLACES).filter((place) =>
        place.text.toLowerCase().includes(needle),
      );
      await json({
        suggestions: matches.map((place) => ({
          placePrediction: {
            placeId: place.id,
            text: { text: place.text },
            structuredFormat: {
              mainText: { text: place.main },
              secondaryText: { text: place.secondary },
            },
          },
        })),
      });
      return;
    }

    const placeId = decodeURIComponent(url.pathname.replace('/v1/places/', ''));
    calls.push({
      kind: 'details',
      apiKey: headers['x-goog-api-key'],
      fieldMask: headers['x-goog-fieldmask'],
      sessionToken: url.searchParams.get('sessionToken') ?? undefined,
      placeId,
    });
    const place = Object.values(PLACES).find((candidate) => candidate.id === placeId);
    if (!place) {
      await route.fulfill({ status: 404, headers: CORS, body: '{}' });
      return;
    }
    await json({
      id: place.id,
      formattedAddress: place.address,
      location: { latitude: place.latitude, longitude: place.longitude },
    });
  });

  return {
    calls,
    failWith: (status) => {
      failure = status;
    },
  };
}
