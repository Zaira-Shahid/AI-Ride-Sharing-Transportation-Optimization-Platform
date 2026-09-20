import { TEST_PORT_OFFSET, emulatorPorts } from '../packages/config/src';

/**
 * The ports the automated tests use for everything they start: the two Expo web servers and the
 * emulators (firebase.test.json). They are the usual ports plus TEST_PORT_OFFSET, so the tests can
 * run while a developer has their own dev server and emulators open.
 */
export const TEST_PORTS = {
  ...emulatorPorts(TEST_PORT_OFFSET),
  passenger: 8081 + TEST_PORT_OFFSET,
  driver: 8082 + TEST_PORT_OFFSET,
} as const;
