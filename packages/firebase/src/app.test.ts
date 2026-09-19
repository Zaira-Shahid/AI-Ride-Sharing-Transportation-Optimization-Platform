import { deleteApp, getApps } from 'firebase/app';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeFirebaseApp } from './app';
import { parseFirebaseWebConfig } from './config';

const config = parseFirebaseWebConfig({
  apiKey: 'test-api-key',
  authDomain: 'example.firebaseapp.com',
  projectId: 'example-project',
  storageBucket: 'example.firebasestorage.app',
  messagingSenderId: '123456789',
  appId: '1:123456789:web:abc',
  measurementId: undefined,
});

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('initializeFirebaseApp', () => {
  it('initialises the app with the provided project configuration', () => {
    expect(initializeFirebaseApp(config).options.projectId).toBe('example-project');
  });

  it('returns the same app instance when called more than once', () => {
    expect(initializeFirebaseApp(config)).toBe(initializeFirebaseApp(config));
    expect(getApps()).toHaveLength(1);
  });
});
