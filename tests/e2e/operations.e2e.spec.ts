import { expect, test, devices } from '@playwright/test';
import { TEST_PORTS } from '../test-ports';
import { PASSWORD, createAccount, firestoreDocs, uniqueEmail } from './helpers';

// Admin console, Operations page (apps/admin/components/OperationsView.tsx): the counts of failed
// route lookups and caught function failures, read through the real getOperationsSummary callable.
// The counters are seeded straight into Firestore (the other specs also leave route counts behind, so
// only a function name no one else uses is asserted exactly), and removed afterwards.

test.use({ ...devices['Desktop Chrome'] });

const ADMIN_URL = `http://localhost:${TEST_PORTS.admin}`;
const FUNCTION_NAME = 'e2e-operations-test-function';

const today = () => new Date().toISOString().slice(0, 10);
const DOC = () => `opsCounters/${today()}_e2e`;

async function seed() {
  const response = await fetch(`${firestoreDocs}/${DOC()}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({
      fields: {
        day: { stringValue: today() },
        counts: {
          mapValue: {
            fields: {
              [`function-failed:${FUNCTION_NAME}`]: { integerValue: '5' },
              'route-unavailable': { integerValue: '2' },
            },
          },
        },
      },
    }),
  });
  expect(response.ok).toBe(true);
}

test.afterAll(async () => {
  await fetch(`${firestoreDocs}/${DOC()}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer owner' },
  });
});

test('staff see the failure counts, and what the counts cannot see', async ({ page }) => {
  await seed();
  const email = uniqueEmail('operations-admin');
  await createAccount(email, 'ADMIN', true, 'Ops Admin');

  await page.goto(ADMIN_URL);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Operations' }).click();

  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Last 7 days' })).toBeVisible();
  await expect(page.getByText('Route lookups unavailable').first()).toBeVisible();
  await expect(page.getByText('Route lookups busy').first()).toBeVisible();

  // The function that was seeded, with its count, in both the day's and the week's table.
  const rows = page.getByRole('row', { name: new RegExp(`${FUNCTION_NAME}\\s+5`) });
  await expect(rows.first()).toBeVisible();

  // The page says what it cannot count, so a zero is not read as "nothing is wrong".
  const note = page.getByRole('note');
  await expect(note).toContainText('never reaches the code that counts');
  await expect(note).toContainText('Cloud Logging');
});
