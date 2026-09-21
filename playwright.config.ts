import { defineConfig, devices } from '@playwright/test';
import { TEST_PORT_OFFSET } from './packages/config/src';
import { TEST_PORTS } from './tests/test-ports';

// End-to-end tests drive the real Expo web builds against the local Firebase emulators, using a
// throwaway demo project and fake client config, so no real credentials are involved.
const projectId = 'demo-ridemesh';

const clientEnv = {
  CI: '1',
  EXPO_PUBLIC_FIREBASE_API_KEY: 'e2e-api-key',
  EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
  EXPO_PUBLIC_FIREBASE_PROJECT_ID: projectId,
  EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET: `${projectId}.appspot.com`,
  EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
  EXPO_PUBLIC_FIREBASE_APP_ID: '1:000000000000:web:e2e',
  EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID: '',
  EXPO_PUBLIC_FIREBASE_EMULATOR_HOST: '127.0.0.1',
  // The emulators the tests start listen on the usual ports plus this (firebase.test.json).
  EXPO_PUBLIC_FIREBASE_EMULATOR_PORT_OFFSET: String(TEST_PORT_OFFSET),
};

// A fake Maps key. The tests answer Google's Places requests themselves, so nothing reaches Google.
const placesEnv = { ...clientEnv, EXPO_PUBLIC_GOOGLE_MAPS_API_KEY: 'e2e-places-key' };

export default defineConfig({
  testDir: 'tests/e2e',
  // Starts the fake geocoder the tests' emulators use (functions/.env.demo-ridemesh).
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { ...devices['Pixel 7'], trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  // Everything the tests start listens on ports above the usual ones (TEST_PORTS: the usual ports
  // plus 10000, and firebase.test.json for the emulators), so the tests can run while a developer has
  // their own dev servers and emulators open. The two Expo servers are still never reused: a server
  // someone already has on these ports would have a different configuration, and the tests would
  // silently run against it. With reuse off, Playwright stops with "http://localhost:18081 is
  // already used" instead. (The tests' own emulators may be reused; the tests only add accounts.)
  webServer: [
    {
      command: `npx firebase emulators:start --config firebase.test.json --only auth,functions,firestore --project ${projectId}`,
      port: TEST_PORTS.auth,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `npm run web --workspace @ridemesh/passenger -- --port ${TEST_PORTS.passenger}`,
      url: `http://localhost:${TEST_PORTS.passenger}`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: placesEnv,
    },
    {
      command: `npm run web --workspace @ridemesh/driver -- --port ${TEST_PORTS.driver}`,
      url: `http://localhost:${TEST_PORTS.driver}`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: placesEnv,
    },
  ],
});
