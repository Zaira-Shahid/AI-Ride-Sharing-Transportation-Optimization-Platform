export const FIREBASE_REGION = 'europe-west1';

// Local emulator ports. They must match the "emulators" section of firebase.json.
export const EMULATOR_PORTS = {
  auth: 9099,
  functions: 5001,
  firestore: 8080,
} as const;

/**
 * The automated tests (end-to-end and integration) run their own emulators and app servers on ports
 * this many higher than the usual ones (firebase.test.json), so that they can run while a developer
 * has their own emulators and dev servers open, and neither blocks the other.
 */
export const TEST_PORT_OFFSET = 10_000;

/** The largest offset an app will accept, so that shifted ports stay valid port numbers. */
export const MAX_PORT_OFFSET = 50_000;

/** The emulator ports, shifted up by `offset` (0 for the ones a developer uses). */
export function emulatorPorts(offset = 0) {
  return {
    auth: EMULATOR_PORTS.auth + offset,
    functions: EMULATOR_PORTS.functions + offset,
    firestore: EMULATOR_PORTS.firestore + offset,
  };
}

/**
 * Reads the optional port offset an app is built with (EXPO_PUBLIC_FIREBASE_EMULATOR_PORT_OFFSET, set
 * only by the tests). Nothing set means 0. Anything else that is not a whole number from 0 to
 * MAX_PORT_OFFSET is an error rather than a quiet 0, because a wrong offset would point the app at
 * somebody else's emulators.
 */
export function parsePortOffset(value: string | undefined): number {
  const text = value?.trim();
  if (!text) return 0;
  const offset = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(offset) || offset > MAX_PORT_OFFSET) {
    throw new Error(
      `EXPO_PUBLIC_FIREBASE_EMULATOR_PORT_OFFSET must be a whole number from 0 to ${MAX_PORT_OFFSET}.`,
    );
  }
  return offset;
}
