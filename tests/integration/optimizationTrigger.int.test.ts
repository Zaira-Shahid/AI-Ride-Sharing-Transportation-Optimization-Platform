import { describe, expect, it } from 'vitest';
import {
  IMMEDIATE_TRIGGER_DEBOUNCE_MS,
  claimImmediateOptimizationRun,
  runImmediateOptimizationIfDue,
} from '../../functions/src/optimizationTrigger';
import { admin } from './support';

// Phase 8, modules 8.1/8.2 (event detection, optimization trigger), against the Firestore emulator:
// the debounce itself (claimImmediateOptimizationRun) and its delegation to runBatchOptimization
// (runImmediateOptimizationIfDue) - not the batch runner's own matching logic, which
// optimizationRun.int.test.ts already covers. A fixed now() lets the debounce window be tested
// without a real wait.

const TRIGGER_DOC = 'system/batchOptimizationTrigger';

async function clearTrigger() {
  await admin()
    .firestore.doc(TRIGGER_DOC)
    .delete()
    .catch(() => undefined);
}

describe('claimImmediateOptimizationRun (functions + firestore emulators)', () => {
  it('claims the first run, with no earlier document', async () => {
    await clearTrigger();
    const start = Date.now();

    expect(
      await claimImmediateOptimizationRun({ firestore: admin().firestore, now: () => start }),
    ).toBe(true);
  });

  it('refuses a second claim within the debounce window', async () => {
    await clearTrigger();
    const start = Date.now();
    await claimImmediateOptimizationRun({ firestore: admin().firestore, now: () => start });

    expect(
      await claimImmediateOptimizationRun({
        firestore: admin().firestore,
        now: () => start + IMMEDIATE_TRIGGER_DEBOUNCE_MS - 1,
      }),
    ).toBe(false);
  });

  it('claims again once the debounce window has passed', async () => {
    await clearTrigger();
    const start = Date.now();
    await claimImmediateOptimizationRun({ firestore: admin().firestore, now: () => start });

    expect(
      await claimImmediateOptimizationRun({
        firestore: admin().firestore,
        now: () => start + IMMEDIATE_TRIGGER_DEBOUNCE_MS,
      }),
    ).toBe(true);
  });
});

describe('runImmediateOptimizationIfDue (functions + firestore emulators)', () => {
  it('runs and returns an outcome the first time', async () => {
    await clearTrigger();
    const start = Date.now();

    const outcome = await runImmediateOptimizationIfDue({
      firestore: admin().firestore,
      provider: { route: () => Promise.reject(new Error('not used in this test')) },
      optimizationService: {
        baseUrl: 'https://opt.example',
        fetchImpl: (() =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ candidates: [] }),
          })) as unknown as typeof fetch,
      },
      now: () => start,
    });

    expect(outcome).not.toBeNull();
    expect(outcome?.matchedRequestCount).toBe(0);
  });

  it('does nothing (null) when a run was already claimed moments ago', async () => {
    await clearTrigger();
    const start = Date.now();
    await claimImmediateOptimizationRun({ firestore: admin().firestore, now: () => start });

    const outcome = await runImmediateOptimizationIfDue({
      firestore: admin().firestore,
      provider: { route: () => Promise.reject(new Error('should not be called')) },
      optimizationService: {
        baseUrl: 'https://opt.example',
        fetchImpl: (() => {
          throw new Error('should not be called');
        }) as unknown as typeof fetch,
      },
      now: () => start + 1,
    });

    expect(outcome).toBeNull();
  });
});
