import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, apps, createAccount, openLogin, submitLogin, uniqueEmail } from './helpers';
import { newPassenger, watchMap } from './map-helpers';

const [, driver] = apps;

// "Now" starts at Sunday 20 September 2026, 10:55:30 in London (summer time, so 09:55:30 UTC), and
// the clock keeps running. Five minutes on is 11:00:30, so the earliest time that can be chosen is
// 11:05 (rounded up to the next step); a lead of only 4 minutes would allow 11:00, which is what makes
// these tests notice a change to the lead. Seven days on is 10:55:30, so the latest is 10:55 on
// Sunday 27 September (rounded down).
const NOW = new Date('2026-09-20T09:55:30Z');
test.use({ locale: 'en-GB', timezoneId: 'Europe/London' });

async function start(page: Page, prefix: string) {
  await page.clock.install({ time: NOW });
  const watch = await watchMap(page);
  await newPassenger(page, prefix);
  watch.serverCalls.length = 0;
  return watch;
}

const card = (page: Page) => page.getByLabel('When', { exact: true });
// The card is a short summary until the passenger asks to change the times.
const edit = (page: Page) => card(page).getByRole('button', { name: 'Change times' }).click();
const done = (page: Page) => card(page).getByRole('button', { name: 'Done' }).click();
const choice = (page: Page, name: string) => card(page).getByRole('radio', { name, exact: true });
const group = (page: Page, name: string) =>
  card(page).getByRole('radiogroup', { name, exact: true });
const chip = (page: Page, groupName: string, name: string) =>
  group(page, groupName).getByRole('radio', { name, exact: true });
const chips = (page: Page, groupName: string) => group(page, groupName).getByRole('radio');

const SOON = 'That leaving time is less than 5 minutes away. Choose a later time, or leave now.';
const ARRIVAL_BEFORE =
  'Your arrival time must be after your departure time. Choose a later arrival time.';

test.describe('passenger app: time preferences', () => {
  test('starts as leave now with no arrival time, as a short summary', async ({ page }) => {
    await start(page, 'time-default');

    await expect(card(page).getByText('When do you want to go?')).toBeVisible();
    await expect(card(page).getByText('Leaving now', { exact: true })).toBeVisible();
    await expect(card(page).getByText('No arrival time', { exact: true })).toBeVisible();
    await expect(card(page).getByRole('alert')).toHaveCount(0);
    await expect(card(page).getByRole('radio')).toHaveCount(0);

    // The editor has the same defaults, and no picker is open.
    await edit(page);
    await expect(choice(page, 'Leave now')).toBeChecked();
    await expect(choice(page, 'No arrival time')).toBeChecked();
    await expect(group(page, 'Leave at: day')).toHaveCount(0);
    await expect(group(page, 'Arrive by: day')).toHaveCount(0);
    await expect(
      card(page).getByText('Times are in your time zone (Europe/London).'),
    ).toBeVisible();

    await done(page);
    await expect(card(page).getByRole('radio')).toHaveCount(0);
    await expect(card(page).getByText('Leaving now', { exact: true })).toBeVisible();
  });

  test('offers only times from 5 minutes to 7 days ahead, in steps of 5 minutes', async ({
    page,
  }) => {
    await start(page, 'time-window');
    await edit(page);
    await choice(page, 'Pick a time').click();

    // The first time is 11:05 today: nothing sooner is offered.
    await expect(choice(page, 'Pick a time')).toBeChecked();
    await expect(chips(page, 'Leave at: day')).toHaveCount(8);
    await expect(chip(page, 'Leave at: day', 'Today')).toBeChecked();
    await expect(chip(page, 'Leave at: day', 'Tomorrow')).toBeVisible();
    await expect(chips(page, 'Leave at: hour')).toHaveCount(13);
    await expect(chip(page, 'Leave at: hour', '11')).toBeChecked();
    await expect(chip(page, 'Leave at: hour', '10')).toHaveCount(0);
    await expect(chips(page, 'Leave at: minute')).toHaveCount(11);
    await expect(chip(page, 'Leave at: minute', ':05')).toBeChecked();
    await expect(chip(page, 'Leave at: minute', ':00')).toHaveCount(0);
    await expect(card(page).getByText('Today, 11:05', { exact: true })).toBeVisible();

    // The last day stops at 10:55: nothing later than 7 days is offered.
    await chips(page, 'Leave at: day').nth(7).click();
    await expect(card(page).getByText(/, 10:55$/)).toBeVisible();
    await expect(chips(page, 'Leave at: hour')).toHaveCount(11);
    await expect(chip(page, 'Leave at: hour', '10')).toBeChecked();
    await expect(chip(page, 'Leave at: hour', '11')).toHaveCount(0);
    await expect(chip(page, 'Leave at: minute', ':55')).toBeChecked();
    await expect(chips(page, 'Leave at: minute')).toHaveCount(12);
    await expect(card(page).getByRole('alert')).toHaveCount(0);
  });

  test('keeps the rest of the time when the day or the hour is changed', async ({ page }) => {
    await start(page, 'time-keep');
    await edit(page);
    await choice(page, 'Pick a time').click();

    await chip(page, 'Leave at: hour', '13').click();
    await expect(card(page).getByText('Today, 13:05', { exact: true })).toBeVisible();
    await chip(page, 'Leave at: minute', ':35').click();
    await expect(card(page).getByText('Today, 13:35', { exact: true })).toBeVisible();

    await chip(page, 'Leave at: day', 'Tomorrow').click();
    await expect(card(page).getByText('Tomorrow, 13:35', { exact: true })).toBeVisible();
    await chip(page, 'Leave at: hour', '09').click();
    await expect(card(page).getByText('Tomorrow, 09:35', { exact: true })).toBeVisible();
    await expect(chip(page, 'Leave at: minute', ':35')).toBeChecked();
  });

  test('says so when a time chosen becomes too soon while the screen is open', async ({ page }) => {
    await start(page, 'time-stale');
    await edit(page);
    await choice(page, 'Pick a time').click();
    await expect(card(page).getByText('Today, 11:05', { exact: true })).toBeVisible();
    await expect(card(page).getByText(SOON)).toHaveCount(0);
    await done(page);
    await expect(card(page).getByText('Leaving Today, 11:05', { exact: true })).toBeVisible();

    // Six minutes pass (now about 11:01:30 in London): 11:05 is under 5 minutes away.
    await page.clock.fastForward('06:00');

    // The message shows even while the card is folded up, next to the time it is about.
    await expect(card(page).getByText(SOON)).toBeVisible();
    await edit(page);
    // The earliest time moves on with the clock: 11:01:30 + 5 minutes rounds up to 11:10.
    await expect(chip(page, 'Leave at: minute', ':05')).toHaveCount(0);
    await chip(page, 'Leave at: minute', ':15').click();
    await expect(card(page).getByText(SOON)).toHaveCount(0);
    await expect(card(page).getByText('Today, 11:15', { exact: true })).toBeVisible();
    await done(page);
    await expect(card(page).getByText('Leaving Today, 11:15', { exact: true })).toBeVisible();
  });

  test('leave now is always allowed, even after a time chosen has gone stale', async ({ page }) => {
    await start(page, 'time-now');
    await edit(page);
    await choice(page, 'Pick a time').click();
    await page.clock.fastForward('06:00');
    await expect(card(page).getByText(SOON)).toBeVisible();

    await choice(page, 'Leave now').click();

    await expect(card(page).getByText(SOON)).toHaveCount(0);
    await expect(group(page, 'Leave at: day')).toHaveCount(0);
  });

  test('sets an arrival time, and asks for a later one when the departure passes it', async ({
    page,
  }) => {
    await start(page, 'time-arrive');
    await edit(page);
    await choice(page, 'Arrive by a time').click();

    // Leaving now: the first arrival time is 11:05 too.
    await expect(choice(page, 'Arrive by a time')).toBeChecked();
    await expect(card(page).getByText('Today, 11:05', { exact: true })).toBeVisible();
    await chip(page, 'Arrive by: hour', '13').click();
    await chip(page, 'Arrive by: minute', ':00').click();
    await expect(card(page).getByText('Today, 13:00', { exact: true })).toBeVisible();
    await expect(card(page).getByText(ARRIVAL_BEFORE)).toHaveCount(0);

    // Leaving at 14:05 is after that arrival time.
    await choice(page, 'Pick a time').click();
    await chip(page, 'Leave at: hour', '14').click();
    await expect(card(page).getByText('Today, 14:05', { exact: true }).first()).toBeVisible();
    await expect(card(page).getByText(ARRIVAL_BEFORE)).toBeVisible();

    // Arrival times now start a minute after the departure, on the next step: 14:10.
    await chip(page, 'Arrive by: hour', '14').click();
    await expect(chips(page, 'Arrive by: minute').first()).toHaveAccessibleName(':10');
    await chip(page, 'Arrive by: hour', '15').click();
    await expect(card(page).getByText(ARRIVAL_BEFORE)).toHaveCount(0);

    // No arrival time again.
    await choice(page, 'No arrival time').click();
    await expect(group(page, 'Arrive by: day')).toHaveCount(0);
  });

  test('keeps the times in the app, sending nothing to the server', async ({ page }) => {
    const watch = await start(page, 'time-private');
    await edit(page);
    await choice(page, 'Pick a time').click();
    await choice(page, 'Arrive by a time').click();
    await expect(group(page, 'Arrive by: day')).toBeVisible();

    expect(watch.serverCalls).toEqual([]);
    await page.reload();
    await expect(card(page).getByText('Leaving now', { exact: true })).toBeVisible();
    await expect(card(page).getByText('No arrival time', { exact: true })).toBeVisible();
  });
});

test.describe('passenger app: time preferences in another time zone', () => {
  test.use({ timezoneId: 'America/New_York' });

  test('shows the same moment in the device time zone', async ({ page }) => {
    await start(page, 'time-newyork');
    await edit(page);
    await expect(
      card(page).getByText('Times are in your time zone (America/New_York).'),
    ).toBeVisible();

    await choice(page, 'Pick a time').click();

    // 09:55:30 UTC is 05:55:30 in New York, so the first time is 06:05 there.
    await expect(card(page).getByText('Today, 06:05', { exact: true })).toBeVisible();
    await expect(chip(page, 'Leave at: hour', '06')).toBeChecked();
    await expect(chip(page, 'Leave at: minute', ':05')).toBeChecked();
  });
});

test.describe('driver app: time preferences', () => {
  test('has no time card', async ({ page }) => {
    const email = uniqueEmail('time-driver');
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
