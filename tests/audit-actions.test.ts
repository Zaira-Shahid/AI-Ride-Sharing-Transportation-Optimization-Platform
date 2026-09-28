import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_LOG_ACTIONS } from '../packages/types/src';

// The audit log page's action filter suggests AUDIT_LOG_ACTIONS. This fails when a module starts
// writing an action that list does not have, so the suggestions cannot quietly fall behind.

const FUNCTIONS_SRC = join(__dirname, '..', 'functions', 'src');

function sourceFiles(): string[] {
  return readdirSync(FUNCTIONS_SRC)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => readFileSync(join(FUNCTIONS_SRC, name), 'utf8'));
}

describe('AUDIT_LOG_ACTIONS', () => {
  it('lists every literal action the functions write', () => {
    const written = new Set<string>();
    for (const source of sourceFiles()) {
      for (const match of source.matchAll(/action:\s*(?:[^'"`\n]*\?\s*)?'([A-Z][A-Z_]+)'/g)) {
        written.add(match[1]!);
      }
      // A conditional such as `delay ? 'A' : 'B'` writes both.
      for (const match of source.matchAll(/action:\s*[^'"`\n]*\?\s*'[A-Z_]+'\s*:\s*'([A-Z_]+)'/g)) {
        written.add(match[1]!);
      }
    }
    expect(written.size).toBeGreaterThan(15);
    expect(
      [...written].filter((action) => !(AUDIT_LOG_ACTIONS as readonly string[]).includes(action)),
    ).toEqual([]);
  });

  it('lists the driver and vehicle review actions built from a template', () => {
    for (const target of ['DRIVER', 'VEHICLE']) {
      expect(AUDIT_LOG_ACTIONS).toContain(`${target}_VERIFICATION_REVIEWED`);
      expect(AUDIT_LOG_ACTIONS).toContain(`${target}_REVIEW_REQUESTED`);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(AUDIT_LOG_ACTIONS).size).toBe(AUDIT_LOG_ACTIONS.length);
  });
});
