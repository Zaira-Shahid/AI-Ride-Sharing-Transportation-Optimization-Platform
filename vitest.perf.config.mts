import { defineConfig } from 'vitest/config';

// Phase 14 (Performance): `npm run perf`, against the emulators, on demand. Not in CI and not in the
// unit run (see vitest.config.mts): wall-clock numbers on a shared runner prove nothing.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/perf/**/*.perf.test.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
