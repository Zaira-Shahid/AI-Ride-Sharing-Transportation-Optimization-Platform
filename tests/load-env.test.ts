import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_OSRM_BASE_PATH, FAKE_OSRM_FOOT_BASE_PATH, FAKE_OSRM_PORT } from './fake-osrm';

// functions/.env.demo-ridemesh-load: what `npm run load` (Phase 14) starts its emulators with. It must
// keep the REAL route limits, which is the thing the load test measures, and it must not be able to
// start the event-triggered batch run that would share the route counters with the test's own.

const root = resolve(__dirname, '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const env = read('functions/.env.demo-ridemesh-load');
const setting = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(env)?.[1]?.trim();

describe('the load run environment', () => {
  it('sends route lookups to the fake route server the load test runs, never a real one', () => {
    expect(setting('ROUTING_BASE_URL_DRIVING')).toBe(
      `http://127.0.0.1:${FAKE_OSRM_PORT}${FAKE_OSRM_BASE_PATH}`,
    );
    expect(setting('ROUTING_BASE_URL_WALKING')).toBe(
      `http://127.0.0.1:${FAKE_OSRM_PORT}${FAKE_OSRM_FOOT_BASE_PATH}`,
    );
    expect(env).not.toContain('openstreetmap');
    expect(env).not.toContain('project-osrm');
  });

  it('does NOT turn the route spacing off, so the real limit applies', () => {
    expect(setting('ROUTING_MIN_SPACING_MS')).toBeUndefined();
    expect(env).not.toMatch(/SPACING/);
  });

  it('has no optimization service URL, so the event-triggered runs do nothing', () => {
    expect(setting('OPTIMIZATION_SERVICE_URL')).toBeUndefined();
  });

  it('holds no secret or address of a person, only settings for the load run', () => {
    expect(env).not.toMatch(/@/);
    expect(env).not.toMatch(/key|secret|token|password/i);
  });

  it('is the project the load script starts, and is allowed past .gitignore', () => {
    expect(read('package.json')).toContain('--project demo-ridemesh-load');
    expect(read('.gitignore')).toContain('!functions/.env.demo-ridemesh-load');
  });
});
