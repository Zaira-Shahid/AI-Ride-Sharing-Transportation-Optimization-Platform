import { positionalReply, startFakeNominatim } from '../fake-nominatim';

/**
 * Runs once before the end-to-end tests: starts the fake geocoder the tests' emulators are told to
 * use (functions/.env.demo-ridemesh), so that no test can reach the real OpenStreetMap server, and
 * stops it afterwards. It answers by position (E2E_GEOCODING in tests/fake-nominatim.ts), which is
 * what lets tests that run side by side share it.
 */
export default async function globalSetup() {
  const fake = await startFakeNominatim({ defaultReply: positionalReply });
  return async () => {
    await fake.close();
  };
}
