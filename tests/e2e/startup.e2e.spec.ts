import { expect, test } from '@playwright/test';
import { apps } from './helpers';

// The apps must show their first screen without waiting for anything outside the app and the
// Firebase emulators. On mobile browsers Firebase Auth's default web setup loads Google's
// apis.google.com script and waits for it before it reports the first sign-in state; when that
// request was slow the app sat on its loading spinner (the intermittent "RideMesh ... heading not
// found" failures). The apps now name their web persistence, which leaves that support out.
const GOOGLE_HOSTS = ['https://apis.google.com/**', 'https://*.firebaseapp.com/**'];

for (const app of apps) {
  test.describe(`${app.role.toLowerCase()} app: start-up`, () => {
    test('shows its first screen even if Google never answers, and never asks it', async ({
      page,
    }) => {
      const asked: string[] = [];
      for (const pattern of GOOGLE_HOSTS) {
        await page.route(pattern, (route) => {
          asked.push(route.request().url());
          // Never answer, like a very slow or blocked network.
          return new Promise(() => undefined);
        });
      }

      await page.goto(app.url);

      await expect(page.getByRole('heading', { name: app.title })).toBeVisible();
      expect(asked).toEqual([]);
    });
  });
}
