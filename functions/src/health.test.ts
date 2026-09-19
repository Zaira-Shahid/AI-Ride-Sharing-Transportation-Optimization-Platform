import { describe, expect, it } from 'vitest';
import { buildHealthResponse } from './health.js';

describe('buildHealthResponse', () => {
  it('reports an ok status without exposing environment details', () => {
    expect(buildHealthResponse()).toEqual({ status: 'ok', service: 'ridemesh-functions' });
  });
});
