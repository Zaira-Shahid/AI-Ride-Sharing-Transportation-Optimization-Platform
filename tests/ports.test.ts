import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMULATOR_PORTS,
  MAX_PORT_OFFSET,
  TEST_PORT_OFFSET,
  emulatorPorts,
  parsePortOffset,
} from '../packages/config/src';
import { FAKE_NOMINATIM_PORT } from './fake-nominatim';
import { FAKE_OSRM_BASE_PATH, FAKE_OSRM_FOOT_BASE_PATH, FAKE_OSRM_PORT } from './fake-osrm';
import { TEST_PORTS } from './test-ports';

const root = resolve(__dirname, '..');
const readJson = (file: string) =>
  JSON.parse(readFileSync(join(root, file), 'utf8')) as {
    firestore: { rules: string; indexes: string };
    functions: { source: string; ignore: string[] }[];
    emulators: Record<string, { port?: number; websocketPort?: number; enabled?: boolean }>;
  };

/** Every port a running firebase emulator setup listens on, from its configuration. */
function portsOf(config: ReturnType<typeof readJson>): number[] {
  return Object.values(config.emulators).flatMap((emulator) =>
    [emulator.port, emulator.websocketPort].filter((port): port is number => port !== undefined),
  );
}

describe('the port offset', () => {
  it('moves the emulator ports up, and by nothing when there is no offset', () => {
    expect(emulatorPorts()).toEqual(EMULATOR_PORTS);
    expect(emulatorPorts(0)).toEqual(EMULATOR_PORTS);
    expect(emulatorPorts(10_000)).toEqual({ auth: 19099, functions: 15001, firestore: 18080 });
  });

  it('is read from the environment, with nothing set meaning no offset', () => {
    expect(parsePortOffset(undefined)).toBe(0);
    expect(parsePortOffset('')).toBe(0);
    expect(parsePortOffset('   ')).toBe(0);
    expect(parsePortOffset('0')).toBe(0);
    expect(parsePortOffset('10000')).toBe(10_000);
    expect(parsePortOffset(' 10000 ')).toBe(10_000);
    expect(parsePortOffset(String(MAX_PORT_OFFSET))).toBe(MAX_PORT_OFFSET);
  });

  it.each(['-1', '1.5', 'abc', '1e4', '0x10', '10 000', String(MAX_PORT_OFFSET + 1)])(
    'refuses %s rather than quietly using no offset',
    (value) => {
      expect(() => parsePortOffset(value)).toThrow(/whole number from 0 to 50000/);
    },
  );
});

describe('the ports the tests use', () => {
  it('are the usual ports plus the test offset', () => {
    expect(TEST_PORT_OFFSET).toBe(10_000);
    expect(TEST_PORTS).toEqual({
      auth: EMULATOR_PORTS.auth + TEST_PORT_OFFSET,
      functions: EMULATOR_PORTS.functions + TEST_PORT_OFFSET,
      firestore: EMULATOR_PORTS.firestore + TEST_PORT_OFFSET,
      passenger: 18_081,
      driver: 18_082,
    });
  });

  it('never include a port a developer normally uses', () => {
    const usual = [
      ...portsOf(readJson('firebase.json')),
      // Expo's default, the emulator hub, logging, event and task emulators, and the UI's own ports.
      8081,
      8082,
      4000,
      4400,
      4500,
      9150,
      9299,
      9499,
    ];
    const used = [...Object.values(TEST_PORTS), ...portsOf(readJson('firebase.test.json'))];
    expect(used.filter((port) => usual.includes(port))).toEqual([]);
  });
});

describe('firebase.test.json', () => {
  const dev = readJson('firebase.json');
  const test = readJson('firebase.test.json');

  it('uses the ports the tests expect', () => {
    expect(test.emulators.auth?.port).toBe(TEST_PORTS.auth);
    expect(test.emulators.functions?.port).toBe(TEST_PORTS.functions);
    expect(test.emulators.firestore?.port).toBe(TEST_PORTS.firestore);
  });

  it('listens on ports that are all different from each other and from firebase.json', () => {
    const ports = portsOf(test);
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports.filter((port) => portsOf(dev).includes(port))).toEqual([]);
    // Every service the emulators start alongside has a port of its own, so none falls back to a
    // usual port that a developer's emulators could be holding.
    for (const name of ['auth', 'functions', 'firestore', 'hub', 'logging', 'eventarc', 'tasks']) {
      expect(test.emulators[name]?.port, name).toBeGreaterThanOrEqual(TEST_PORT_OFFSET);
    }
  });

  it('has no emulator UI, and is otherwise the same set-up as firebase.json', () => {
    expect(test.emulators.ui?.enabled).toBe(false);
    expect(test.firestore).toEqual(dev.firestore);
    expect(test.functions.map((entry) => entry.source)).toEqual(
      dev.functions.map((entry) => entry.source),
    );
  });

  it('does not reload the functions when they are rebuilt during a run', () => {
    for (const entry of test.functions) expect(entry.ignore).toContain('lib');
  });
});

describe('the fake geocoder the tests use', () => {
  const env = readFileSync(join(root, 'functions/.env.demo-ridemesh'), 'utf8');
  const setting = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(env)?.[1]?.trim();

  it("is where the tests' emulators are told Nominatim is, never the real server", () => {
    expect(setting('NOMINATIM_BASE_URL')).toBe(`http://127.0.0.1:${FAKE_NOMINATIM_PORT}`);
    expect(env).not.toContain('openstreetmap.org');
  });

  it('does not use a port anything else in the tests uses', () => {
    const used = [
      ...Object.values(TEST_PORTS),
      ...portsOf(readJson('firebase.test.json')),
      ...portsOf(readJson('firebase.json')),
    ];
    expect(used).not.toContain(FAKE_NOMINATIM_PORT);
  });

  it('turns the spacing between lookups off, so tests side by side cannot make each other busy', () => {
    expect(setting('GEOCODING_MIN_SPACING_MS')).toBe('0');
  });

  it('holds no address of a person or a secret, only settings for the tests', () => {
    expect(env).not.toMatch(/@/);
    expect(env).not.toMatch(/key|secret|token|password/i);
  });
});

describe('the fake route server the tests use', () => {
  const env = readFileSync(join(root, 'functions/.env.demo-ridemesh'), 'utf8');
  const setting = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(env)?.[1]?.trim();

  it("is where the tests' emulators are told OSRM is, never the real server", () => {
    expect(setting('ROUTING_BASE_URL_DRIVING')).toBe(
      `http://127.0.0.1:${FAKE_OSRM_PORT}${FAKE_OSRM_BASE_PATH}`,
    );
    expect(env).not.toContain('openstreetmap.de');
    expect(env).not.toContain('project-osrm');
  });

  it('has a foot server as well as a car server, on the same fake and never the real one', () => {
    // A walking route is a walking route because of which server is asked, so the tests' emulators
    // are given a foot server of their own, apart from the car server.
    expect(setting('ROUTING_BASE_URL_WALKING')).toBe(
      `http://127.0.0.1:${FAKE_OSRM_PORT}${FAKE_OSRM_FOOT_BASE_PATH}`,
    );
    expect(setting('ROUTING_BASE_URL_WALKING')).not.toBe(setting('ROUTING_BASE_URL_DRIVING'));
  });

  it('does not use a port anything else in the tests uses', () => {
    const used = [
      ...Object.values(TEST_PORTS),
      ...portsOf(readJson('firebase.test.json')),
      ...portsOf(readJson('firebase.json')),
      FAKE_NOMINATIM_PORT,
    ];
    expect(used).not.toContain(FAKE_OSRM_PORT);
  });

  it('turns the spacing between routes off, so tests side by side cannot make each other busy', () => {
    expect(setting('ROUTING_MIN_SPACING_MS')).toBe('0');
  });
});
