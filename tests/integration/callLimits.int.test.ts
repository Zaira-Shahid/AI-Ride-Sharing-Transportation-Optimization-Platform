import { describe, expect, it } from 'vitest';
import { enforceCallRateLimit } from '../../functions/src/callLimits';
import { admin } from './support';

// Phase 14 (Security audit, module "rate limiting"). Each hardened callable's own test file (
// registration, trip-request, availability, tripExecution, paymentMethods, location) has its own
// lightweight "the wiring refuses once exhausted" test; this file is the one place the shared
// counting/window logic itself (allow up to the limit, refuse over it, reset after the window,
// separate scopes/callers never share a counter) is proven, directly against the real Firestore
// emulator (a real transaction, not a fake).

describe('enforceCallRateLimit', () => {
  it('allows exactly maxCalls, then refuses the next one, within the window', async () => {
    const { firestore } = admin();
    const uid = `caller-${Date.now()}-${Math.random()}`;
    const limit = { windowMs: 60_000, maxCalls: 3 };
    const now = 1_000_000;

    for (let i = 0; i < 3; i += 1) {
      await expect(
        enforceCallRateLimit(firestore, 'scope-a', uid, now + i, limit),
      ).resolves.toBeUndefined();
    }
    await expect(
      enforceCallRateLimit(firestore, 'scope-a', uid, now + 3, limit),
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  it('resets once the window has passed', async () => {
    const { firestore } = admin();
    const uid = `caller-${Date.now()}-${Math.random()}`;
    const limit = { windowMs: 1_000, maxCalls: 1 };

    await enforceCallRateLimit(firestore, 'scope-b', uid, 2_000_000, limit);
    await expect(
      enforceCallRateLimit(firestore, 'scope-b', uid, 2_000_500, limit),
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
    await expect(
      enforceCallRateLimit(firestore, 'scope-b', uid, 2_001_001, limit),
    ).resolves.toBeUndefined();
  });

  it('keeps two different scopes for the same caller apart', async () => {
    const { firestore } = admin();
    const uid = `caller-${Date.now()}-${Math.random()}`;
    const limit = { windowMs: 60_000, maxCalls: 1 };

    await enforceCallRateLimit(firestore, 'scope-c1', uid, 3_000_000, limit);
    await expect(
      enforceCallRateLimit(firestore, 'scope-c2', uid, 3_000_000, limit),
    ).resolves.toBeUndefined();
  });

  it('keeps two different callers in the same scope apart', async () => {
    const { firestore } = admin();
    const limit = { windowMs: 60_000, maxCalls: 1 };

    await enforceCallRateLimit(firestore, 'scope-d', 'caller-d1', 4_000_000, limit);
    await expect(
      enforceCallRateLimit(firestore, 'scope-d', 'caller-d2', 4_000_000, limit),
    ).resolves.toBeUndefined();
  });
});
