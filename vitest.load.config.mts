import { defineConfig } from 'vitest/config';

// Phase 14 (Load testing): `npm run load`, against the emulators under the project demo-ridemesh-load,
// on demand. Not in CI and not in the unit run (see vitest.config.mts): wall-clock numbers on a shared
// runner prove nothing.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/load/**/*.load.test.ts'],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
