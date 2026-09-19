import { describe, expect, it } from 'vitest';
import { AuthFlowError, describeAuthError } from './auth-errors';
import { deriveSessionStatus } from './session';

describe('describeAuthError', () => {
  it.each([
    ['auth/email-already-in-use', 'email-in-use', false],
    ['auth/invalid-email', 'invalid-email', false],
    ['auth/weak-password', 'weak-password', false],
    ['auth/network-request-failed', 'network', true],
    ['auth/too-many-requests', 'too-many-requests', true],
    ['functions/unavailable', 'network', true],
    ['functions/failed-precondition', 'role-conflict', false],
    ['functions/invalid-argument', 'validation', false],
    ['functions/permission-denied', 'permission', false],
    ['functions/internal', 'server', true],
    ['functions/not-found', 'server', true],
  ])('maps %s to %s', (code, kind, retryable) => {
    const failure = describeAuthError({ code, message: 'Firebase: raw technical text' });
    expect(failure.kind).toBe(kind);
    expect(failure.retryable).toBe(retryable);
  });

  it('never leaks raw technical text', () => {
    const raw = 'Firebase: Error (auth/some-internal-thing) at line 42';
    for (const error of [
      { code: 'auth/some-internal-thing', message: raw },
      new Error(raw),
      'a string',
      null,
      undefined,
    ]) {
      const failure = describeAuthError(error);
      expect(failure.message).not.toContain('Firebase');
      expect(failure.message).not.toContain('auth/');
    }
  });

  it('falls back to a generic retryable message for unknown errors', () => {
    expect(describeAuthError(new Error('boom'))).toMatchObject({
      kind: 'unknown',
      retryable: true,
    });
  });

  it('keeps the message of our own validation errors', () => {
    const failure = describeAuthError(new AuthFlowError('validation', 'Please check the fields.'));
    expect(failure).toEqual({
      kind: 'validation',
      message: 'Please check the fields.',
      retryable: false,
    });
  });
});

describe('deriveSessionStatus', () => {
  it('walks through every state', () => {
    expect(deriveSessionStatus({ signedIn: false, emailVerified: false, role: null })).toBe(
      'signedOut',
    );
    expect(deriveSessionStatus({ signedIn: true, emailVerified: false, role: 'DRIVER' })).toBe(
      'unverified',
    );
    expect(deriveSessionStatus({ signedIn: true, emailVerified: true, role: null })).toBe(
      'incomplete',
    );
    expect(deriveSessionStatus({ signedIn: true, emailVerified: true, role: 'DRIVER' })).toBe(
      'ready',
    );
  });
});
