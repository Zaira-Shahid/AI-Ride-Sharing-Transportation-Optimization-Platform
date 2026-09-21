import { positionalReply, startFakeNominatim } from '../fake-nominatim';
import { positionalRouteReply, startFakeOsrm } from '../fake-osrm';

/**
 * Runs once before the end-to-end tests: starts the fake geocoder and the fake route server the tests'
 * emulators are told to use (functions/.env.demo-ridemesh), so that no test can reach the real
 * OpenStreetMap or routing servers, and stops them afterwards. Each answers by position (E2E_GEOCODING
 * in tests/fake-nominatim.ts, E2E_ROUTING in tests/fake-osrm.ts), which is what lets tests that run
 * side by side share them. Every trip request made in a test gets its estimate from the fake route
 * server a moment later, as it does from the real one.
 */
export default async function globalSetup() {
  const nominatim = await startFakeNominatim({ defaultReply: positionalReply });
  const osrm = await startFakeOsrm({ defaultReply: positionalRouteReply });
  return async () => {
    await Promise.all([nominatim.close(), osrm.close()]);
  };
}
