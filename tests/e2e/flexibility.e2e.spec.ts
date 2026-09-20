import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, apps, createAccount, openLogin, submitLogin, uniqueEmail } from './helpers';
import { newPassenger, watchMap } from './map-helpers';

const [, driver] = apps;

const card = (page: Page) => page.getByLabel('Flexibility', { exact: true });
// The card is a short summary until the passenger asks to change it.
const edit = (page: Page) => card(page).getByRole('button', { name: 'Change flexibility' }).click();
const done = (page: Page) => card(page).getByRole('button', { name: 'Done' }).click();
const level = (page: Page, name: string) => card(page).getByRole('radio', { name, exact: true });
const toggle = (page: Page, name: string) => card(page).getByRole('switch', { name, exact: true });
const text = (page: Page, value: string) => card(page).getByText(value, { exact: true });

const LIMITS = {
  strict: 'Walk up to 200 m, up to 5 extra minutes, up to 1 km off the direct route.',
  balanced: 'Walk up to 500 m, up to 10 extra minutes, up to 3 km off the direct route.',
  flexible: 'Walk up to 1000 m, up to 20 extra minutes, up to 5 km off the direct route.',
};

async function start(page: Page, prefix: string) {
  const watch = await watchMap(page);
  await newPassenger(page, prefix);
  watch.serverCalls.length = 0;
  return watch;
}

test.describe('passenger app: flexibility', () => {
  test('starts as Balanced, sharing and route changes allowed, as a short summary', async ({
    page,
  }) => {
    await start(page, 'flex-default');

    await expect(card(page).getByText('How flexible are you?')).toBeVisible();
    await expect(text(page, 'Balanced')).toBeVisible();
    await expect(text(page, LIMITS.balanced)).toBeVisible();
    await expect(text(page, 'Sharing allowed · Route changes allowed')).toBeVisible();
    await expect(card(page).getByRole('radio')).toHaveCount(0);
    await expect(card(page).getByRole('switch')).toHaveCount(0);

    // The editor has the same defaults.
    await edit(page);
    await expect(level(page, 'Balanced')).toBeChecked();
    await expect(toggle(page, 'Share my ride')).toBeChecked();
    await expect(toggle(page, 'Allow route changes')).toBeChecked();
    await expect(text(page, 'Reasonable walking and route changes.')).toBeVisible();
    await expect(
      text(page, 'We will not go beyond these limits without asking you first.'),
    ).toBeVisible();

    await done(page);
    await expect(card(page).getByRole('radio')).toHaveCount(0);
  });

  test('sets the numbers from the level, and route changes from it too', async ({ page }) => {
    await start(page, 'flex-levels');
    await edit(page);

    await level(page, 'Strict').click();
    await expect(level(page, 'Strict')).toBeChecked();
    await expect(text(page, 'No meaningful route changes.')).toBeVisible();
    await expect(text(page, LIMITS.strict)).toBeVisible();
    await expect(toggle(page, 'Allow route changes')).not.toBeChecked();
    await expect(toggle(page, 'Share my ride')).toBeChecked();

    await level(page, 'Flexible').click();
    await expect(
      text(page, 'Significant shared routing if it saves cost, time or emissions.'),
    ).toBeVisible();
    await expect(text(page, LIMITS.flexible)).toBeVisible();
    await expect(toggle(page, 'Allow route changes')).toBeChecked();

    await done(page);
    await expect(text(page, 'Flexible')).toBeVisible();
    await expect(text(page, LIMITS.flexible)).toBeVisible();
    await expect(text(page, 'Sharing allowed · Route changes allowed')).toBeVisible();
  });

  test('lets the passenger switch sharing and route changes, and a level resets only the latter', async ({
    page,
  }) => {
    await start(page, 'flex-switches');
    await edit(page);

    // Not sharing: the level stays as it was.
    await toggle(page, 'Share my ride').click();
    await expect(toggle(page, 'Share my ride')).not.toBeChecked();
    await expect(level(page, 'Balanced')).toBeChecked();

    // Choosing a level keeps the sharing choice and takes route changes from the level.
    await level(page, 'Strict').click();
    await expect(toggle(page, 'Share my ride')).not.toBeChecked();
    await expect(toggle(page, 'Allow route changes')).not.toBeChecked();

    // Route changes can be switched on under Strict; the level stays Strict.
    await toggle(page, 'Allow route changes').click();
    await expect(toggle(page, 'Allow route changes')).toBeChecked();
    await expect(level(page, 'Strict')).toBeChecked();
    await done(page);
    await expect(text(page, 'Strict')).toBeVisible();
    await expect(text(page, LIMITS.strict)).toBeVisible();
    await expect(text(page, 'Sharing not allowed · Route changes allowed')).toBeVisible();

    // Choosing the level again puts route changes back to what the level says.
    await edit(page);
    await level(page, 'Strict').click();
    await expect(toggle(page, 'Allow route changes')).not.toBeChecked();
    await expect(toggle(page, 'Share my ride')).not.toBeChecked();
  });

  test('keeps the choice in the app, sending nothing to the server', async ({ page }) => {
    const watch = await start(page, 'flex-private');
    await edit(page);
    await level(page, 'Flexible').click();
    await toggle(page, 'Share my ride').click();
    await done(page);
    await expect(text(page, 'Sharing not allowed · Route changes allowed')).toBeVisible();

    expect(watch.serverCalls).toEqual([]);
    await page.reload();
    await expect(text(page, 'Balanced')).toBeVisible();
    await expect(text(page, 'Sharing allowed · Route changes allowed')).toBeVisible();
  });
});

test.describe('driver app: flexibility', () => {
  test('has no flexibility card', async ({ page }) => {
    const email = uniqueEmail('flex-driver');
    await createAccount(email, driver.role, true, 'Dan Driver', {
      name: 'Dan Driver',
      phone: '+44 7700 900123',
    });
    await openLogin(page, driver.url, driver.title);
    await submitLogin(page, email, PASSWORD);

    await expect(page.getByText(driver.home)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });
});
