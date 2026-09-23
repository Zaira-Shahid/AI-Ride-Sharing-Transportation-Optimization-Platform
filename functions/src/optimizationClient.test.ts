import { describe, expect, it, vi } from 'vitest';
import {
  optimizationServiceUrlFromEnvironment,
  requestCandidates,
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
