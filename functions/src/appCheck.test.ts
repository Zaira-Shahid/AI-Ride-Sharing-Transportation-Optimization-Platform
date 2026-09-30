import { describe, expect, it } from 'vitest';
import { enforceAppCheckFromEnvironment } from './appCheck';

describe('enforceAppCheckFromEnvironment', () => {
  it('is false when ENFORCE_APP_CHECK is unset', () => {
    expect(enforceAppCheckFromEnvironment({})).toBe(false);
  });

  it('is false for anything other than the exact string "true"', () => {
    expect(enforceAppCheckFromEnvironment({ ENFORCE_APP_CHECK: 'TRUE' })).toBe(false);
    expect(enforceAppCheckFromEnvironment({ ENFORCE_APP_CHECK: '1' })).toBe(false);
    expect(enforceAppCheckFromEnvironment({ ENFORCE_APP_CHECK: 'yes' })).toBe(false);
  });

  it('is true only for the exact string "true"', () => {
    expect(enforceAppCheckFromEnvironment({ ENFORCE_APP_CHECK: 'true' })).toBe(true);
  });
});
