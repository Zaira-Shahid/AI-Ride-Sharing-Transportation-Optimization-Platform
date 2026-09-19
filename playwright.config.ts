import { defineConfig, devices } from '@playwright/test';

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
};

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { ...devices['Pixel 7'], trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    {
      command: `npx firebase emulators:start --only auth,functions,firestore --project ${projectId}`,
      port: 9099,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run web --workspace @ridemesh/passenger -- --port 8081',
      url: 'http://localhost:8081',
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: clientEnv,
    },
    {
      command: 'npm run web --workspace @ridemesh/driver -- --port 8082',
      url: 'http://localhost:8082',
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: clientEnv,
    },
  ],
});
