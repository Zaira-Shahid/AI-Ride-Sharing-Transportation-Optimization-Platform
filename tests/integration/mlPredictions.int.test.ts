import { httpsCallable } from 'firebase/functions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getMlStatus, predictCancellationRisk, predictEta } from '../../packages/firebase/src';
import { startOptimizationService, type OptimizationService } from '../optimization-service';
import { admin, createClient, signUp, verifyEmail } from './support';

// Phase 13 (AI/ML). Unlike optimizationRun.int.test.ts (a scripted fetchImpl stands in for the
// Python service there), this file starts the REAL Python service (services/optimization/app),
// the same helper phase6/8-acceptance already use - the only way to prove the actual scikit-learn
// models the admin dashboard's own "AI Predictions" page calls (through getMlStatus/predictEta/
// predictCancellationRisk) really train and predict, not just that the TS side is wired correctly.
// Both prototypes are trained on SYNTHETIC data only - see services/optimization/app/ml/__init__.py
// and functions/src/mlPredictions.ts's own header comment for the hard boundary this file's own
// assertions never cross: nothing here feeds a real matching, payment or notification decision.

let optimizationService: OptimizationService;

beforeAll(async () => {
  optimizationService = await startOptimizationService();
}, 30_000);

afterAll(async () => {
  await optimizationService.close();
});

async function staff(prefix: string, role = 'SUPPORT') {
  const client = createClient();
  const { user, uid, email } = await signUp(client, prefix);
  await admin().auth.setCustomUserClaims(uid, { role });
  await verifyEmail(user, email);
  return { client, uid };
}

async function passenger(prefix: string) {
  const client = createClient();
  const { user, email } = await signUp(client, prefix);
  await httpsCallable(
    client.functions,
    'completeRegistration',
  )({ role: 'PASSENGER', name: 'Test Person' });
  await verifyEmail(user, email);
  return client;
}

const INPUT = { distanceKm: 8, hourOfDay: 8, dayOfWeek: 2, naiveDurationSeconds: 1152 };

describe('getMlStatus', () => {
  it('any staff role reads model metadata, all labeled as a synthetic-data prototype', async () => {
    const { client } = await staff('ml-status', 'SUPPORT');

    const status = await getMlStatus(client);

    expect(status.prototype).toBe(true);
    expect(status.trainedOn).toBe('synthetic_data');
    expect(status.dataSource).toBe('SyntheticTripDataSource');
    expect(status.trainedRowCount).toBeGreaterThan(0);
    expect(status.etaValidationMeanAbsoluteErrorSeconds).toBeGreaterThan(0);
    expect(status.cancellationValidationAuc).toBeGreaterThan(0);
    expect(status.warning.toLowerCase()).toContain('synthetic');
    expect(status.warning).toContain('not production-ready');
  }, 20_000);

  it('is refused for a passenger, and for someone signed out', async () => {
    const client = await passenger('ml-status-passenger');

    await expect(getMlStatus(client)).rejects.toMatchObject({ kind: 'permission' });
    await expect(getMlStatus(createClient())).rejects.toBeTruthy();
  }, 20_000);
});

describe('predictEta', () => {
  it('any staff role gets a labeled, positive prediction for a manually entered trip', async () => {
    const { client } = await staff('ml-eta', 'OPERATIONS');

    const prediction = await predictEta(client, INPUT);

    expect(prediction.predictedDurationSeconds).toBeGreaterThan(0);
    expect(prediction.prototype).toBe(true);
    expect(prediction.trainedOn).toBe('synthetic_data');
  }, 20_000);

  it('predicts a longer duration at rush hour than late at night for the same trip', async () => {
    const { client } = await staff('ml-eta-rush');

    const rushHour = await predictEta(client, { ...INPUT, hourOfDay: 8 });
    const lateNight = await predictEta(client, { ...INPUT, hourOfDay: 3 });

    expect(rushHour.predictedDurationSeconds).toBeGreaterThan(lateNight.predictedDurationSeconds);
  }, 20_000);

  it('is refused for a passenger', async () => {
    const client = await passenger('ml-eta-passenger');

    await expect(predictEta(client, INPUT)).rejects.toMatchObject({ kind: 'permission' });
  }, 20_000);
});

describe('predictCancellationRisk', () => {
  it('any staff role gets a labeled probability for a manually entered trip', async () => {
    const { client } = await staff('ml-cancel', 'ADMIN');

    const prediction = await predictCancellationRisk(client, INPUT);

    expect(prediction.cancellationRisk).toBeGreaterThanOrEqual(0);
    expect(prediction.cancellationRisk).toBeLessThanOrEqual(1);
    expect(prediction.prototype).toBe(true);
    expect(prediction.trainedOn).toBe('synthetic_data');
  }, 20_000);

  it('is refused for a passenger', async () => {
    const client = await passenger('ml-cancel-passenger');

    await expect(predictCancellationRisk(client, INPUT)).rejects.toMatchObject({
      kind: 'permission',
    });
  }, 20_000);
});
