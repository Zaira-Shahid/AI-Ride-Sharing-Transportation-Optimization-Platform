import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { httpsCallable } from 'firebase/functions';
import { beforeAll, describe, expect, it } from 'vitest';
import { listDriversForReview } from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail } from '../integration/support';

// Phase 14 (Performance). Not part of CI: wall-clock time on a shared runner proves nothing and makes
// a test flaky, so this runs on demand (`npm run perf`) and writes its numbers to
// tests/perf/last-run.json (git-ignored; vitest does not show a test's console output when it runs
// under the emulators, so the file is what to read) for docs/performance.md. It asserts only that
// everything it timed succeeded.
//
// These are EMULATOR numbers: the Functions and Firestore emulators on a developer's machine, with no
// network to a data centre, no cold starts to speak of and no other load. They say whether something
// got slower or scales badly (the shape), not how long a real request takes (the value). The spec asks
// for real targets to be "validated through load testing" (a separate module).

const HOME = {
  latitude: 51.5049,
  longitude: -0.0195,
  formattedAddress: 'Canary Wharf, London, UK',
  placeId: 'place-home',
};
const OFFICE = {
  latitude: 51.5074,
  longitude: -0.1278,
  formattedAddress: 'Trafalgar Square, London, UK',
  placeId: 'place-office',
};
const REQUEST = {
  origin: HOME,
  destination: OFFICE,
  departure: { kind: 'NOW' },
  arriveBy: null,
  preferences: {
    flexibilityLevel: 'BALANCED',
    maxWalkingDistance: 500,
    maxExtraTime: 10,
    maxDetourDistance: 3,
    allowSharedRide: true,
    allowRouteChange: true,
  },
};

const RESULTS_FILE = fileURLToPath(new URL('./last-run.json', import.meta.url));
const results: Record<string, unknown>[] = [];

/** Keeps every result so far in the file, so one is not lost if a later one fails. */
function record(result: Record<string, unknown>) {
  results.push(result);
  writeFileSync(RESULTS_FILE, `${JSON.stringify(results, null, 2)}\n`);
}

beforeAll(() => {
  writeFileSync(RESULTS_FILE, '[]\n');
});

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};
const rounded = (value: number) => Math.round(value * 10) / 10;

async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  const value = await run();
  return { ms: performance.now() - started, value };
}

describe('trip request creation (spec section 69: under 1 second, excluding external APIs)', () => {
  it('measures createTripRequest as the passenger app calls it', async () => {
    const SAMPLES = 30;
    const passengers: ReturnType<typeof createClient>[] = [];
    for (let i = 0; i < SAMPLES + 2; i += 1) {
      const client = createClient();
      const { user, email } = await signUp(client, `perf-passenger-${i}`);
      await httpsCallable(
        client.functions,
        'completeRegistration',
      )({
        role: 'PASSENGER',
        name: 'Perf Person',
      });
      await verifyEmail(user, email);
      passengers.push(client);
    }
    const create = (index: number) =>
      httpsCallable<unknown, { tripId: string }>(
        passengers[index]!.functions,
        'createTripRequest',
      )(REQUEST);

    // Two warm-up calls: the first one in a fresh emulator loads the function.
    await create(0);
    await create(1);

    const times: number[] = [];
    for (let i = 2; i < SAMPLES + 2; i += 1) {
      const { ms, value } = await timed(() => create(i));
      expect(value.data.tripId).toBeTruthy();
      times.push(ms);
    }

    record({
      measure: 'createTripRequest',
      where: 'emulators',
      samples: times.length,
      medianMs: rounded(median(times)),
      p95Ms: rounded(percentile(times, 95)),
      maxMs: rounded(Math.max(...times)),
      specTargetMs: 1000,
    });
    expect(times).toHaveLength(SAMPLES);
  }, 300_000);
});

describe('the first page of the admin Drivers list, as the list grows', () => {
  async function seedDrivers(from: number, to: number) {
    const writer = admin().firestore.bulkWriter();
    const now = new Date();
    for (let i = from; i < to; i += 1) {
      const uid = `perf-driver-${String(i).padStart(5, '0')}`;
      const status = ['PENDING', 'VERIFIED', 'REJECTED'][i % 3];
      void writer.set(admin().firestore.doc(`users/${uid}`), {
        role: 'DRIVER',
        name: `Perf Driver ${i}`,
        email: `${uid}@example.test`,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      void writer.set(admin().firestore.doc(`drivers/${uid}`), {
        userId: uid,
        verificationStatus: status,
        verificationReason: null,
        createdAt: now,
        updatedAt: now,
      });
      void writer.set(admin().firestore.doc(`vehicles/${uid}`), {
        driverId: uid,
        type: 'CAR',
        make: 'Toyota',
        model: 'Prius',
        plateNumber: `P${i}`,
        plateKey: `P${i}`,
        verificationStatus: status,
        verificationReason: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    await writer.close();
  }

  async function firstPageMs(client: ReturnType<typeof createClient>) {
    const times: number[] = [];
    for (let run = 0; run < 7; run += 1) {
      const { ms, value } = await timed(() => listDriversForReview(client));
      expect(value.rows.length).toBeLessThanOrEqual(50);
      times.push(ms);
    }
    return rounded(median(times));
  }

  it('stays the same size whether there are 100 drivers or 1,000', async () => {
    const staff = createClient();
    const { user, uid, email } = await signUp(staff, 'perf-staff');
    await admin().auth.setCustomUserClaims(uid, { role: 'ADMIN' });
    await verifyEmail(user, email);

    await seedDrivers(0, 100);
    const at100 = await firstPageMs(staff);
    await seedDrivers(100, 1000);
    const at1000 = await firstPageMs(staff);

    // What reading EVERY driver (what the page did before it was paged) costs at 1,000 drivers: the
    // same pages, all of them.
    let cursor = null as Awaited<ReturnType<typeof listDriversForReview>>['nextCursor'];
    let everything = 0;
    const whole = await timed(async () => {
      do {
        const page = await listDriversForReview(staff, { cursor });
        everything += page.rows.length;
        cursor = page.nextCursor;
      } while (cursor);
    });

    record({
      measure: 'listDriversForReview first page (50 rows, each joined to its user and vehicle)',
      where: 'emulators',
      medianMsAt100Drivers: at100,
      medianMsAt1000Drivers: at1000,
      readingAll1000DriversMs: rounded(whole.ms),
      rowsReadingAll: everything,
    });
    expect(everything).toBeGreaterThanOrEqual(1000);
  }, 300_000);
});
