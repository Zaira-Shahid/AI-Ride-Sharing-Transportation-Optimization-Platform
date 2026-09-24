import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { runBatchOptimization, type BatchOptimizationOutcome } from './optimizationRun.js';
import type { OptimizationServiceConfig } from './optimizationClient.js';
import type { RoutingProvider } from './routing.js';

// Phase 8 (Dynamic Re-optimization), modules 8.1/8.2 (event detection, optimization trigger): until
// now the batch optimization run (Module 6.9/6.10) only ever happened on its own 2-minute schedule,
// so a passenger could wait up to that long even when nothing else was pending. The one Firestore
// document below tracks the last time an IMMEDIATE run happened, so that a trip request reaching
// SEARCHING - a brand new request, or one released back to it by a driver cancellation (Module 8.5) -
// can trigger a run right away instead of waiting for the schedule. The schedule itself is untouched
// and keeps running regardless, as a backstop for anything this trigger misses.
//
// Several requests reaching SEARCHING in a short burst (a wave of new requests, or several passengers
// released at once) must still be looked at together in ONE run, not one run each - that is the whole
// point of batch optimization over the old per-request matching (Module 5.5, retired). The debounce
// window below makes that so: only the first trigger within the window actually starts a run: whoever
// or whatever else reaches SEARCHING moments later is naturally included in that same run's own
// snapshot of every open request, or otherwise safely waits for the next scheduled one.

export const IMMEDIATE_TRIGGER_DEBOUNCE_MS = 20_000;

const TRIGGER_DOC_PATH = 'system/batchOptimizationTrigger';

/**
 * Whether an immediate run should proceed right now (true), or be skipped (false) because one was
 * already claimed within IMMEDIATE_TRIGGER_DEBOUNCE_MS. A Firestore transaction on one shared
 * document makes this atomic across concurrent invocations, so concurrently-triggered requests never
 * both start their own run.
 */
export async function claimImmediateOptimizationRun(deps: {
  firestore: Firestore;
  now?: () => number;
}): Promise<boolean> {
  const { firestore } = deps;
  const now = (deps.now ?? Date.now)();
  const ref = firestore.doc(TRIGGER_DOC_PATH);

  return firestore.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const lastAt: unknown = snapshot.get('lastImmediateRunAt');
    if (lastAt instanceof Timestamp && now - lastAt.toMillis() < IMMEDIATE_TRIGGER_DEBOUNCE_MS) {
      return false;
    }
    // Written from `now`, not FieldValue.serverTimestamp(): the two must agree for the elapsed-time
    // check above to mean anything, including under an injected `now` in tests.
    tx.set(ref, { lastImmediateRunAt: Timestamp.fromMillis(now) }, { merge: true });
    return true;
  });
}

/**
 * Claims and runs an immediate batch optimization run, or does nothing (returning null) when one was
 * already claimed too recently (see claimImmediateOptimizationRun). Never throws: the caller is a
 * Firestore trigger that must not fail just because a run could not be attempted or itself failed.
 */
export async function runImmediateOptimizationIfDue(deps: {
  firestore: Firestore;
  provider: RoutingProvider;
  optimizationService: OptimizationServiceConfig;
  now?: () => number;
}): Promise<BatchOptimizationOutcome | null> {
  const proceed = await claimImmediateOptimizationRun({
    firestore: deps.firestore,
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (!proceed) return null;
  return runBatchOptimization(deps);
}
