import { expect, test, devices, type Page } from '@playwright/test';
import { TEST_PORTS } from '../test-ports';
import { PASSWORD, createAccount, firestoreDocs, uniqueEmail } from './helpers';

// Admin console, Live Network page (apps/admin/components/LiveMap.tsx). The map used to open on the
// whole world and never frame the network, so every marker collapsed into one dot until staff zoomed
// in by hand - something no unit or integration test could see, only a real browser. These tests pin
// the two halves of the fix: the first data frames the markers, and a later poll does not undo the
// staff member's own zoom.
//
// The e2e emulators are shared with every other spec, and specs that ran earlier leave open trips and
// active journeys in London, Bristol and Sydney. On a map showing all of those the network is
// legitimately a few dots and no zoom level proves anything, so this spec first clears every other open
// trip and active journey (nothing later depends on them: each spec creates its own), then seeds a
// small network and checks the framing of exactly that. The assertions never depend on a particular
// zoom level: they check that the network fills a useful part of the view (a world-zoom map squeezes it
// into a few pixels) and that every marker is inside the visible map.

test.use({ ...devices['Desktop Chrome'] });

const ADMIN_URL = `http://localhost:${TEST_PORTS.admin}`;

// A 1x1 transparent PNG, so the map's tiles never leave the machine (nothing here is about tiles).
const BLANK_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const point = (latitude: number, longitude: number) => ({
  mapValue: {
    fields: { latitude: { doubleValue: latitude }, longitude: { doubleValue: longitude } },
  },
});
const place = (latitude: number, longitude: number, address: string) => ({
  mapValue: {
    fields: {
      latitude: { doubleValue: latitude },
      longitude: { doubleValue: longitude },
      formattedAddress: { stringValue: address },
    },
  },
});

// Far from every other spec's places (Sydney), and cleaned up afterwards, so no other spec's global
// matching run can ever see these journeys and requests.
const JOURNEY_IDS = ['livemap-e2e-journey-0', 'livemap-e2e-journey-1'];
const TRIP_IDS = ['livemap-e2e-trip-0', 'livemap-e2e-trip-1', 'livemap-e2e-trip-2'];
/** 2 vehicles + a pickup and a drop-off for each of 3 trips. */
const MARKERS_SEEDED = 2 + 3 * 2;

async function write(path: string, fields: Record<string, unknown>) {
  const response = await fetch(`${firestoreDocs}/${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({ fields }),
  });
  expect(response.ok).toBe(true);
}

async function remove(path: string) {
  await fetch(`${firestoreDocs}/${path}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer owner' },
  });
}

const OPEN_TRIP_STATUSES = [
  'REQUESTED',
  'SEARCHING',
  'MATCHED',
  'PICKUP_ASSIGNED',
  'DRIVER_ARRIVING',
  'PICKED_UP',
  'IN_TRANSIT',
  'DROPOFF_APPROACHING',
];
const ACTIVE_JOURNEY_STATUSES = ['AVAILABLE', 'MATCHING', 'ACTIVE'];

/** Deletes every document of a collection whose status is one of `statuses`. */
async function removeWithStatus(collection: string, statuses: string[]) {
  let pageToken = '';
  do {
    const response = await fetch(
      `${firestoreDocs}/${collection}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`,
      { headers: { authorization: 'Bearer owner' } },
    );
    const body = (await response.json()) as {
      documents?: { name: string; fields?: { status?: { stringValue?: string } } }[];
      nextPageToken?: string;
    };
    for (const doc of body.documents ?? []) {
      if (statuses.includes(doc.fields?.status?.stringValue ?? '')) {
        await remove(doc.name.split('/documents/')[1] ?? '');
      }
    }
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
}

async function clearNetwork() {
  await removeWithStatus('tripRequests', OPEN_TRIP_STATUSES);
  await removeWithStatus('driverJourneys', ACTIVE_JOURNEY_STATUSES);
}

async function seedNetwork() {
  const now = new Date().toISOString();
  const journeys = [
    {
      status: 'ACTIVE',
      at: [-33.87, 151.21],
      from: [-33.88, 151.2],
      to: [-33.85, 151.25],
      matched: ['a', 'b'],
    },
    {
      status: 'AVAILABLE',
      at: [-33.89, 151.18],
      from: [-33.9, 151.17],
      to: [-33.86, 151.22],
      matched: [],
    },
  ];
  for (const [i, j] of journeys.entries()) {
    await write(`driverJourneys/${JOURNEY_IDS[i]}`, {
      status: { stringValue: j.status },
      currentLocation: point(j.at[0]!, j.at[1]!),
      origin: point(j.from[0]!, j.from[1]!),
      destination: point(j.to[0]!, j.to[1]!),
      matchedTripRequestIds: {
        arrayValue: { values: j.matched.map((id) => ({ stringValue: id })) },
      },
      createdAt: { timestampValue: now },
      updatedAt: { timestampValue: now },
    });
  }
  // Never REQUESTED: the create trigger would rewrite it. SEARCHING is left alone (no optimization
  // service runs in the e2e emulators).
  const trips = [
    { status: 'SEARCHING', from: [-33.865, 151.215], to: [-33.84, 151.23], shared: false },
    { status: 'PICKUP_ASSIGNED', from: [-33.875, 151.19], to: [-33.855, 151.24], shared: true },
    { status: 'DRIVER_ARRIVING', from: [-33.895, 151.2], to: [-33.87, 151.26], shared: false },
  ];
  for (const [i, t] of trips.entries()) {
    await write(`tripRequests/${TRIP_IDS[i]}`, {
      passengerId: { stringValue: `livemap-e2e-passenger-${i}` },
      passengerName: { stringValue: `Rider ${i}` },
      status: { stringValue: t.status },
      sharedRide: { booleanValue: t.shared },
      origin: place(t.from[0]!, t.from[1]!, `Pickup ${i}`),
      destination: place(t.to[0]!, t.to[1]!, `Dropoff ${i}`),
      paymentStatus: { nullValue: null },
      requestedAt: { timestampValue: now },
      createdAt: { timestampValue: now },
      updatedAt: { timestampValue: now },
    });
  }
}

async function removeNetwork() {
  for (const id of JOURNEY_IDS) await remove(`driverJourneys/${id}`);
  for (const id of TRIP_IDS) await remove(`tripRequests/${id}`);
}

/** Signs in as staff and opens Live Network, with the seeded markers drawn. */
async function openLiveNetwork(page: Page) {
  await page.route('**://tile.openstreetmap.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_TILE }),
  );
  const email = uniqueEmail('livemap-admin');
  await createAccount(email, 'ADMIN', true, 'Ops Admin');

  await page.goto(ADMIN_URL);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Live Network' }).click();
  await expect(page.getByText('Network efficiency')).toBeVisible();
  // At least the seeded markers (another spec's leftovers may add more).
  await expect
    .poll(() => page.locator('.leaflet-marker-icon').count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(MARKERS_SEEDED);
}

interface MarkerGeometry {
  count: number;
  /**
   * How far everything the map draws spreads (markers and the dashed route lines, whose ends are part
   * of what the map frames), as the larger of its share of the map's width and of its height.
   */
  fill: number;
  /** Whether every marker's centre is inside the visible map. */
  allInside: boolean;
  /** Every marker's rounded centre, sorted, to compare two moments. */
  positions: string[];
}

async function markerGeometry(page: Page): Promise<MarkerGeometry> {
  const region = page.getByRole('region', { name: 'Live network map' });
  const map = await region.boundingBox();
  if (!map) throw new Error('The live map is not on the page.');
  const centres: { x: number; y: number }[] = [];
  // Every corner of everything drawn, to measure how far the whole network spreads.
  const extent: { x: number; y: number }[] = [];
  for (const icon of await page.locator('.leaflet-marker-icon').all()) {
    const box = await icon.boundingBox();
    if (!box) continue;
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    centres.push(centre);
    extent.push(centre);
  }
  // The dashed route lines, only those inside the map (other icons on the page are dashed paths too,
  // and the heat circles have no dash). A line with nothing
  // drawn (clipped away, or not yet laid out) reports a zero-size box at the page's corner, which
  // would stretch the measure to a corner that is not part of the network, so it is left out.
  for (const line of await region.locator('path[stroke-dasharray]').all()) {
    const box = await line.boundingBox();
    if (!box || (box.width < 1 && box.height < 1)) continue;
    extent.push({ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height });
  }
  const xs = extent.map((c) => c.x);
  const ys = extent.map((c) => c.y);
  return {
    count: centres.length,
    fill: Math.max(
      (Math.max(...xs) - Math.min(...xs)) / map.width,
      (Math.max(...ys) - Math.min(...ys)) / map.height,
    ),
    allInside: centres.every(
      (c) => c.x >= map.x && c.x <= map.x + map.width && c.y >= map.y && c.y <= map.y + map.height,
    ),
    positions: centres.map((c) => `${Math.round(c.x)},${Math.round(c.y)}`).sort(),
  };
}

test.describe('admin live map framing', () => {
  test.beforeAll(async () => {
    await clearNetwork();
    await seedNetwork();
  });
  test.afterAll(removeNetwork);

  test('opens framed on the network, not on the whole world', async ({ page }) => {
    await openLiveNetwork(page);
    // Let the fit and its animation finish.
    await page.waitForTimeout(1500);

    const geometry = await markerGeometry(page);
    expect(geometry.allInside).toBe(true);
    // Fitted, the network fills a good part of the map in at least one direction: Leaflet fits to a
    // whole zoom level, so anywhere from about 40% to 80% depending on the shape. At the old world
    // zoom it was a few pixels (about 1%).
    expect(geometry.fill).toBeGreaterThan(0.25);
  });

  test('a later poll does not undo the staff member own zoom', async ({ page }) => {
    await openLiveNetwork(page);
    await page.waitForTimeout(1500);

    // Staff zoom in by hand, then the 15 second poll redraws every marker.
    await page.locator('.leaflet-control-zoom-in').click();
    await page.waitForTimeout(700);
    await page.locator('.leaflet-control-zoom-in').click();
    await page.waitForTimeout(1200);
    const before = await markerGeometry(page);

    await page.waitForResponse((response) => response.url().includes('listActiveTripPositions'), {
      timeout: 40_000,
    });
    await page.waitForTimeout(1500);
    const after = await markerGeometry(page);

    // The same markers in the same places: a re-fit would have moved every one of them.
    expect(after.count).toBe(before.count);
    expect(after.positions).toEqual(before.positions);
  });
});
