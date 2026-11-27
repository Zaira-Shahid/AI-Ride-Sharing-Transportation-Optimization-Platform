import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTripRequest,
  declareDestination,
  saveVehicle,
  setJourneyDetour,
  setJourneyOrigin,
  setJourneySeats,
  setVehicleCapacity,
} from '../../packages/firebase/src';
import { admin, createClient, signUp, verifyEmail } from './support';
import { clearScenarioCollections, runConsumerScenario } from './golden/consumer-scenario';

// CHARACTERIZATION TEST for module A3a (docs/a3-company-matching-design.md, section 7). It records, in
// a golden file, exactly what consumer matching did BEFORE the company changes, so that after them the
// same test must produce the identical file. It was written, and its golden file generated, on the
// unchanged code, in its own commit. The scenario itself lives in golden/consumer-scenario.ts so the
// mixed-world test (company-matching.int.test.ts) can run the identical consumer world with companies
// added.
//
// To regenerate the golden file on purpose: UPDATE_GOLDEN=1 (never as part of an A3a change).

const GOLDEN_PATH = join(__dirname, 'golden', 'consumer-matching.golden.json');

beforeEach(clearScenarioCollections);

describe('consumer matching, characterized (functions + firestore emulators)', () => {
  it('produces exactly the recorded results across every matching path', async () => {
    const { consumer } = await runConsumerScenario();
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(consumer, null, 2)}\n`);
    }
    expect(existsSync(GOLDEN_PATH), 'the golden file must be committed').toBe(true);
    expect(consumer).toEqual(JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')));
  });
});

// ---- The shape of documents consumers create through the real functions ---------------------------
// Recorded once, from real callables: a consumer's trip request and journey carry exactly these keys
// today, so after A3a they must carry exactly these keys again - in particular no `companyId`, not
// even a null one.

const SHAPE_PATH = join(__dirname, 'golden', 'consumer-document-shapes.golden.json');

describe('consumer document shapes, characterized', () => {
  it('writes the same keys on a consumer trip request and journey as before', async () => {
    const driverClient = createClient();
    const driver = await signUp(driverClient, 'golden-shape-d');
    await httpsCallable(
      driverClient.functions,
      'completeRegistration',
    )({ role: 'DRIVER', name: 'D' });
    await verifyEmail(driver.user, driver.email);
    await saveVehicle(driverClient, {
      type: 'CAR',
      make: 'Toyota',
      model: 'Corolla',
      plateNumber: `SHP-${Date.now() % 100000}`,
    });
    await setVehicleCapacity(driverClient, 4);
    await declareDestination(driverClient, {
      latitude: 70.05,
      longitude: 0,
      formattedAddress: 'Destination',
      placeId: null,
    });
    await setJourneyOrigin(driverClient, { latitude: 70, longitude: 0 });
    await setJourneySeats(driverClient, 2);
    await setJourneyDetour(driverClient, 60, 30);
    const driverDoc = await admin().firestore.doc(`drivers/${driver.uid}`).get();
    const journeyId = driverDoc.get('currentJourneyId') as string;

    const passengerClient = createClient();
    const passenger = await signUp(passengerClient, 'golden-shape-p');
    await httpsCallable(
      passengerClient.functions,
      'completeRegistration',
    )({
      role: 'PASSENGER',
      name: 'P',
    });
    await verifyEmail(passenger.user, passenger.email);
    const tripId = await createTripRequest(passengerClient, {
      origin: { latitude: -40, longitude: 100, formattedAddress: 'Far pickup', placeId: null },
      destination: {
        latitude: -39,
        longitude: 100,
        formattedAddress: 'Far destination',
        placeId: null,
      },
      departure: { kind: 'NOW' },
      arriveBy: null,
      preferences: {
        flexibilityLevel: 'FLEXIBLE',
        maxWalkingDistance: 1000,
        maxExtraTime: 20,
        maxDetourDistance: 5,
        allowSharedRide: true,
        allowRouteChange: true,
      },
    });
    // Let the request's own triggers finish, so the keys they add are in the record too.
    const stop = Date.now() + 20_000;
    for (;;) {
      const status = (await admin().firestore.doc(`tripRequests/${tripId}`).get()).get('status');
      if (status === 'SEARCHING' || Date.now() > stop) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const tripKeys = Object.keys(
      (await admin().firestore.doc(`tripRequests/${tripId}`).get()).data() ?? {},
    ).sort();
    const journeyKeys = Object.keys(
      (await admin().firestore.doc(`driverJourneys/${journeyId}`).get()).data() ?? {},
    ).sort();

    const actual = { tripRequestKeys: tripKeys, driverJourneyKeys: journeyKeys };
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(dirname(SHAPE_PATH), { recursive: true });
      writeFileSync(SHAPE_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(existsSync(SHAPE_PATH), 'the golden file must be committed').toBe(true);
    expect(actual).toEqual(JSON.parse(readFileSync(SHAPE_PATH, 'utf8')));
    expect(tripKeys).not.toContain('companyId');
    expect(journeyKeys).not.toContain('companyId');
  });
});
