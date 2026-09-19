import { describe, expect, it } from 'vitest';
import { FirebaseConfigError, parseFirebaseWebConfig } from './config';

const complete = {
  apiKey: 'test-api-key',
  authDomain: 'example.firebaseapp.com',
  projectId: 'example-project',
  storageBucket: 'example.firebasestorage.app',
  messagingSenderId: '123456789',
  appId: '1:123456789:web:abc',
  measurementId: undefined,
};

describe('parseFirebaseWebConfig', () => {
  it('returns a validated config when every required value is present', () => {
    const config = parseFirebaseWebConfig(complete);
    expect(config.projectId).toBe('example-project');
    expect(config.measurementId).toBeUndefined();
  });

  it('throws a FirebaseConfigError listing every missing key', () => {
    try {
      parseFirebaseWebConfig({ ...complete, apiKey: undefined, appId: '   ' });
      expect.unreachable('expected parseFirebaseWebConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(FirebaseConfigError);
      expect((error as FirebaseConfigError).missingKeys.sort()).toEqual(['apiKey', 'appId']);
    }
  });

  it('never includes configuration values in the error message', () => {
    try {
      parseFirebaseWebConfig({ ...complete, projectId: undefined });
    } catch (error) {
      expect((error as Error).message).not.toContain('test-api-key');
    }
  });
});
