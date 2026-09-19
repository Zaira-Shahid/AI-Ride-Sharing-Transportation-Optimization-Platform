import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  APP_DISPLAY_NAMES,
  BUNDLE_IDENTIFIERS,
  FIREBASE_REGION,
  NPM_SCOPE,
} from '@ridemesh/config';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const readJson = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;

const workspaceDirs = [
  'apps/passenger',
  'apps/driver',
  'apps/admin',
  'packages/config',
  'packages/types',
  'packages/ui',
  'packages/firebase',
  'functions',
];

describe('monorepo structure (spec section 50)', () => {
  it('contains every workspace and top-level directory from Module 0.1', () => {
    for (const dir of [...workspaceDirs, 'services/optimizer', 'docs', 'tests', 'scripts']) {
      expect(existsSync(join(root, dir)), `${dir} should exist`).toBe(true);
    }
  });

  it('scopes every workspace package to @ridemesh', () => {
    for (const dir of workspaceDirs) {
      const pkg = readJson(`${dir}/package.json`);
      expect(String(pkg.name).startsWith(`${NPM_SCOPE}/`), `${dir} name`).toBe(true);
    }
  });
});

describe('Firebase configuration structure', () => {
  it('pins the default Firebase project', () => {
    const rc = readJson('.firebaserc') as { projects: { default: string } };
    expect(rc.projects.default).toBe('ai-ride-sharing-system-a6743');
  });

  it('runs Cloud Functions in the configured region', () => {
    expect(FIREBASE_REGION).toBe('europe-west1');
    expect(read('functions/src/index.ts')).toContain(
      `setGlobalOptions({ region: '${FIREBASE_REGION}' })`,
    );
  });

  it('keeps collections without their own rules closed to every client', () => {
    const rules = read('firestore.rules');
    expect(rules).toContain('allow read, write: if false;');
    expect(rules).not.toMatch(/allow [a-z, ]+: if true/);
  });

  it('never commits environment files containing values', () => {
    expect(read('.gitignore')).toMatch(/^\.env$/m);
    for (const app of ['admin', 'passenger', 'driver']) {
      const example = read(`apps/${app}/.env.example`);
      for (const line of example.split('\n')) {
        if (line.trim() === '' || line.startsWith('#')) continue;
        expect(line, `${app} .env.example must not contain values`).toMatch(/^[A-Z0-9_]+=$/);
      }
    }
  });
});

describe('product branding', () => {
  it('uses the configured display names in the mobile app manifests', () => {
    const passenger = readJson('apps/passenger/app.json') as { expo: { name: string } };
    const driver = readJson('apps/driver/app.json') as { expo: { name: string } };
    expect(passenger.expo.name).toBe(APP_DISPLAY_NAMES.passenger);
    expect(driver.expo.name).toBe(APP_DISPLAY_NAMES.driver);
  });

  it('uses the configured bundle identifiers in the mobile app manifests', () => {
    type Manifest = { expo: { ios: { bundleIdentifier: string }; android: { package: string } } };
    for (const app of ['passenger', 'driver'] as const) {
      const { expo } = readJson(`apps/${app}/app.json`) as Manifest;
      expect(expo.ios.bundleIdentifier).toBe(BUNDLE_IDENTIFIERS[app]);
      expect(expo.android.package).toBe(BUNDLE_IDENTIFIERS[app]);
    }
  });

  it('exposes no coding-agent branding in product source', () => {
    const forbidden = /claude|anthropic|copilot|cursor ai|chatgpt/i;
    const skip = new Set(['node_modules', '.next', '.expo', 'coverage']);
    const productDirs = ['apps', 'packages', 'functions/src'];

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        if (skip.has(name)) return [];
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });

    const offenders = productDirs
      .flatMap((dir) => walk(join(root, dir)))
      .filter((file) => /\.(ts|tsx|json|css|md|mjs)$/.test(file))
      .filter((file) => !file.endsWith('repository.test.ts'))
      .filter((file) => forbidden.test(readFileSync(file, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
