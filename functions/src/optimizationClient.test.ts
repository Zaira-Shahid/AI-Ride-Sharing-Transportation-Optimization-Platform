import { describe, expect, it, vi } from 'vitest';
import {
  optimizationServiceUrlFromEnvironment,
  requestCancellationPrediction,
  requestCandidates,
  requestEtaPrediction,
  requestMlStatus,
  requestOptimize,
} from './optimizationClient';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

describe('optimizationServiceUrlFromEnvironment', () => {
  it('is null when OPTIMIZATION_SERVICE_URL is unset', () => {
    expect(optimizationServiceUrlFromEnvironment({})).toBeNull();
  });

  it('reads and trims OPTIMIZATION_SERVICE_URL', () => {
    expect(
      optimizationServiceUrlFromEnvironment({
        OPTIMIZATION_SERVICE_URL: '  https://opt.example  ',
      }),
    ).toBe('https://opt.example');
  });
});

describe('requestCandidates', () => {
  it('posts to /candidates and returns the parsed body', async () => {
    const fetchImpl = fakeFetch(200, { candidates: [] });

    const result = await requestCandidates(
      { baseUrl: 'https://opt.example', fetchImpl },
      { requests: [], journeys: [] },
    );

    expect(result).toEqual({ candidates: [] });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://opt.example/candidates',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('strips a trailing slash from the base URL', async () => {
    const fetchImpl = fakeFetch(200, { candidates: [] });

    await requestCandidates(
      { baseUrl: 'https://opt.example/', fetchImpl },
      { requests: [], journeys: [] },
    );

    expect(fetchImpl).toHaveBeenCalledWith('https://opt.example/candidates', expect.anything());
  });

  it('throws when the service answers with an error status', async () => {
    const fetchImpl = fakeFetch(500, { detail: 'boom' });

    await expect(
      requestCandidates(
        { baseUrl: 'https://opt.example', fetchImpl },
        { requests: [], journeys: [] },
      ),
    ).rejects.toThrow('500');
  });
});

describe('requestOptimize', () => {
  it('posts to /optimize and returns the parsed body', async () => {
    const summary = {
      requested_count: 0,
      matched_count: 0,
      dropped_after_sharing_count: 0,
      unmatched_count: 0,
      unmatched_by_reason: {},
      journeys_used: 0,
      total_distance_meters: 0,
      total_duration_seconds: 0,
      validation_issue_count: 0,
      run_duration_seconds: 0.1,
    };
    const fetchImpl = fakeFetch(200, {
      plans: [],
      explanations: [],
      validation_issues: [],
      summary,
    });

    const result = await requestOptimize(
      { baseUrl: 'https://opt.example', fetchImpl },
      { request_ids: [], costs: [], available_seats: {}, matrices: {} },
    );

    expect(result.summary).toEqual(summary);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://opt.example/optimize',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

const PREDICTION_INPUT = {
  distance_km: 8,
  hour_of_day: 8,
  day_of_week: 2,
  naive_duration_seconds: 1152,
};

describe('requestMlStatus', () => {
  it('gets /ml/status and returns the parsed body', async () => {
    const body = {
      prototype: true as const,
      trained_on: 'synthetic_data' as const,
      trained_at: '2026-01-01T00:00:00Z',
      trained_row_count: 10000,
      data_source: 'SyntheticTripDataSource',
      eta_validation_mean_absolute_error_seconds: 100.5,
      cancellation_validation_auc: 0.629,
      warning: 'prototype warning',
    };
    const fetchImpl = fakeFetch(200, body);

    const result = await requestMlStatus({ baseUrl: 'https://opt.example', fetchImpl });

    expect(result).toEqual(body);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://opt.example/ml/status',
      expect.not.objectContaining({ method: 'POST' }),
    );
  });

  it('throws when the service answers with an error status', async () => {
    const fetchImpl = fakeFetch(503, { detail: 'not trained yet' });

    await expect(requestMlStatus({ baseUrl: 'https://opt.example', fetchImpl })).rejects.toThrow(
      '503',
    );
  });
});

describe('requestEtaPrediction', () => {
  it('posts to /ml/eta/predict and returns the parsed body', async () => {
    const body = {
      predicted_duration_seconds: 1789.2,
      prototype: true as const,
      trained_on: 'synthetic_data' as const,
    };
    const fetchImpl = fakeFetch(200, body);

    const result = await requestEtaPrediction(
      { baseUrl: 'https://opt.example', fetchImpl },
      PREDICTION_INPUT,
    );

    expect(result).toEqual(body);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://opt.example/ml/eta/predict',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('requestCancellationPrediction', () => {
  it('posts to /ml/cancellation/predict and returns the parsed body', async () => {
    const body = {
      cancellation_risk: 0.69,
      prototype: true as const,
      trained_on: 'synthetic_data' as const,
    };
    const fetchImpl = fakeFetch(200, body);

    const result = await requestCancellationPrediction(
      { baseUrl: 'https://opt.example', fetchImpl },
      PREDICTION_INPUT,
    );

    expect(result).toEqual(body);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://opt.example/ml/cancellation/predict',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
