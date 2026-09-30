import { describe, expect, it, vi } from 'vitest';
import {
  getMlStatusForStaff,
  predictCancellationForStaff,
  predictEtaForStaff,
} from './mlPredictions';
import {
  requestCancellationPrediction,
  requestEtaPrediction,
  requestMlStatus,
} from './optimizationClient';
import type { StaffCaller } from './verification';

// Phase 13 (AI/ML). Unlike analytics.ts/payments.ts, this module has no Firestore dependency at
// all - just a staff-role check plus one HTTP call - so, unlike those, it is unit-testable here
// rather than needing an emulator-backed integration test. The HTTP call itself is mocked the same
// way optimizationClient.test.ts already mocks `fetch` for requestCandidates/requestOptimize.

vi.mock('./optimizationClient', () => ({
  requestMlStatus: vi.fn(),
  requestEtaPrediction: vi.fn(),
  requestCancellationPrediction: vi.fn(),
}));

const STAFF: StaffCaller = { uid: 'staff-1', role: 'SUPPORT', emailVerified: true };
const UNVERIFIED_STAFF: StaffCaller = { uid: 'staff-2', role: 'SUPPORT', emailVerified: false };
const NON_STAFF: StaffCaller = { uid: 'passenger-1', role: 'PASSENGER', emailVerified: true };
const CONFIG = { baseUrl: 'https://opt.example' };

const INPUT = { distanceKm: 8, hourOfDay: 8, dayOfWeek: 2, naiveDurationSeconds: 1152 };

describe('getMlStatusForStaff', () => {
  it('rejects a non-staff caller', async () => {
    await expect(getMlStatusForStaff({ optimizationService: CONFIG }, NON_STAFF)).rejects.toThrow(
      'not allowed',
    );
  });

  it('rejects an unverified staff caller', async () => {
    await expect(
      getMlStatusForStaff({ optimizationService: CONFIG }, UNVERIFIED_STAFF),
    ).rejects.toThrow('not allowed');
  });

  it('rejects when the optimization service is not configured', async () => {
    await expect(getMlStatusForStaff({ optimizationService: null }, STAFF)).rejects.toThrow(
      'not available',
    );
  });

  it('translates the service response to camelCase and labels it a prototype', async () => {
    vi.mocked(requestMlStatus).mockResolvedValue({
      prototype: true,
      trained_on: 'synthetic_data',
      trained_at: '2026-01-01T00:00:00Z',
      trained_row_count: 10000,
      data_source: 'SyntheticTripDataSource',
      eta_validation_mean_absolute_error_seconds: 100.5,
      cancellation_validation_auc: 0.629,
      warning: 'This is a prototype...',
    });

    const result = await getMlStatusForStaff({ optimizationService: CONFIG }, STAFF);

    expect(result).toEqual({
      prototype: true,
      trainedOn: 'synthetic_data',
      trainedAt: '2026-01-01T00:00:00Z',
      trainedRowCount: 10000,
      dataSource: 'SyntheticTripDataSource',
      etaValidationMeanAbsoluteErrorSeconds: 100.5,
      cancellationValidationAuc: 0.629,
      warning: 'This is a prototype...',
    });
    expect(requestMlStatus).toHaveBeenCalledWith(CONFIG);
  });
});

describe('predictEtaForStaff', () => {
  it('rejects a non-staff caller without calling the service', async () => {
    await expect(
      predictEtaForStaff({ optimizationService: CONFIG }, NON_STAFF, INPUT),
    ).rejects.toThrow('not allowed');
    expect(requestEtaPrediction).not.toHaveBeenCalled();
  });

  it('sends snake_case fields and returns a labeled prediction', async () => {
    vi.mocked(requestEtaPrediction).mockResolvedValue({
      predicted_duration_seconds: 1789.2,
      prototype: true,
      trained_on: 'synthetic_data',
    });

    const result = await predictEtaForStaff({ optimizationService: CONFIG }, STAFF, INPUT);

    expect(result).toEqual({
      predictedDurationSeconds: 1789.2,
      prototype: true,
      trainedOn: 'synthetic_data',
    });
    expect(requestEtaPrediction).toHaveBeenCalledWith(CONFIG, {
      distance_km: 8,
      hour_of_day: 8,
      day_of_week: 2,
      naive_duration_seconds: 1152,
    });
  });
});

describe('predictCancellationForStaff', () => {
  it('rejects a non-staff caller without calling the service', async () => {
    await expect(
      predictCancellationForStaff({ optimizationService: CONFIG }, NON_STAFF, INPUT),
    ).rejects.toThrow('not allowed');
    expect(requestCancellationPrediction).not.toHaveBeenCalled();
  });

  it('sends snake_case fields and returns a labeled prediction', async () => {
    vi.mocked(requestCancellationPrediction).mockResolvedValue({
      cancellation_risk: 0.69,
      prototype: true,
      trained_on: 'synthetic_data',
    });

    const result = await predictCancellationForStaff({ optimizationService: CONFIG }, STAFF, INPUT);

    expect(result).toEqual({
      cancellationRisk: 0.69,
      prototype: true,
      trainedOn: 'synthetic_data',
    });
    expect(requestCancellationPrediction).toHaveBeenCalledWith(CONFIG, {
      distance_km: 8,
      hour_of_day: 8,
      day_of_week: 2,
      naive_duration_seconds: 1152,
    });
  });
});
