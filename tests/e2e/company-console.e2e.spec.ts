import AxeBuilder from '@axe-core/playwright';
import { devices, expect, test, type Page } from '@playwright/test';
import { TEST_PORTS } from '../test-ports';
import {
  PASSWORD,
  apiKey,
  authEmulator,
  createAccount,
  projectId,
  resetCodeFor,
  uniqueEmail,
} from './helpers';

// The company console (apps/corporate), module A4a: an administrator signs up, verifies their email,
// creates the company and lands on the overview; everyone else is turned away. It runs in a real
// browser against the real console, functions and emulators. See docs/a4-company-dashboard-design.md.

const CONSOLE_URL = `http://localhost:${TEST_PORTS.corporate}`;
const REFUSAL = 'This account cannot use the company console.';

test.use({ ...devices['Desktop Chrome'] });

/** The most recent verification code the Auth emulator issued for an address. */
async function verificationCodeFor(email: string) {
  const response = await fetch(`${authEmulator}/emulator/v1/projects/${projectId}/oobCodes`);
  const { oobCodes } = (await response.json()) as {
    oobCodes: { email: string; oobCode: string; requestType: string }[];
  };
  return oobCodes
    .filter((entry) => entry.email === email && entry.requestType === 'VERIFY_EMAIL')
    .at(-1)?.oobCode;
}

/** What opening the link in the verification email does. */
async function clickVerificationLink(email: string) {
  await expect.poll(() => verificationCodeFor(email)).toBeTruthy();
  const response = await fetch(
    `${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:update?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oobCode: await verificationCodeFor(email) }),
    },
  );
  expect(response.ok).toBe(true);
}

/** Gives an existing account company claims, the way the server does, without going through the console. */
async function setClaims(email: string, claims: Record<string, string>) {
  const lookup = await fetch(
    `${authEmulator}/identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:lookup`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({ email: [email] }),
    },
  );
  const { users } = (await lookup.json()) as { users: { localId: string }[] };
  const update = await fetch(
    `${authEmulator}/identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:update`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({
        localId: users[0]!.localId,
        customAttributes: JSON.stringify(claims),
      }),
    },
  );
  expect(update.ok).toBe(true);
}

// Written as text because the browser's own objects are not part of this project's type libraries.
const HYDRATED = `[...document.querySelectorAll('button, input')].some((element) =>
  Object.keys(element).some((key) => key.startsWith('__reactFiber')))`;
const SCROLLS_SIDEWAYS =
  'document.documentElement.scrollWidth > document.documentElement.clientWidth';

/**
 * Opens a page and waits until React has taken it over. The development server compiles a page the
 * first time it is asked for, and anything typed or clicked before that is lost (a click even submits
 * the form the old-fashioned way), so a test waits instead of racing it.
 */
async function open(page: Page, path: string) {
  await page.goto(`${CONSOLE_URL}${path}`);
  await page.waitForFunction(HYDRATED);
}

async function signUp(page: Page, name: string, email: string) {
  await open(page, '/sign-up');
  await page.getByLabel('Your full name').fill(name);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
}

async function signIn(page: Page, email: string) {
  await open(page, '/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** A verified administrator with a company, ready on the overview. */
async function founderOnOverview(page: Page, companyName: string) {
  const email = uniqueEmail('console-founder');
  await signUp(page, 'Fiona Founder', email);
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  await clickVerificationLink(email);
  await page.getByRole('button', { name: 'I have verified my email' }).click();
  await expect(page.getByRole('heading', { name: 'Create your company' })).toBeVisible();
  await page.getByLabel('Company name').fill(companyName);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  return email;
}

async function expectNoAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    results.violations.map(
      (violation) =>
        `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(' ')).join('; ')})`,
    ),
    'accessibility violations',
  ).toEqual([]);
}

test.describe('an administrator sets up their company', () => {
  test('signs up, verifies, creates the company and sees the overview', async ({ page }) => {
    const email = uniqueEmail('console-journey');
    await signUp(page, 'Ada Admin', email);

    // Not verified yet: only the verification page is available, wherever they try to go.
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    await page.goto(CONSOLE_URL);
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();

    await page.getByRole('button', { name: 'I have verified my email' }).click();
    await expect(page.getByText('Your email is not verified yet')).toBeVisible();

    await page.getByRole('button', { name: 'Send the email again' }).click();
    await expect(page.getByText('We sent the email again')).toBeVisible();

    await clickVerificationLink(email);
    await page.getByRole('button', { name: 'I have verified my email' }).click();

    // Verified, but no company yet.
    await expect(page.getByRole('heading', { name: 'Create your company' })).toBeVisible();
    await page.goto(CONSOLE_URL);
    await expect(page.getByRole('heading', { name: 'Create your company' })).toBeVisible();

    await page.getByLabel('Company name').fill('Journey Ltd');
    await expect(page.getByLabel('Your full name')).toHaveValue('Ada Admin');
    await page.getByRole('button', { name: 'Create company' }).click();

    // The overview: a new company is one employee and nothing else, and no menu item leads nowhere.
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByTestId('company-name')).toHaveText('Journey Ltd');
    await expect(page.getByTestId('tile-employees')).toContainText('1');
    for (const key of ['pendingInvitations', 'driverApplications', 'approvedDrivers']) {
      await expect(page.getByTestId(`tile-${key}`)).toContainText('0');
    }
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link')).toHaveCount(
      1,
    );
    await expect(page.getByText(email)).toBeVisible();

    // Entry pages are no longer reachable.
    await page.goto(`${CONSOLE_URL}/create-company`);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

    // Signing out and in again comes back to the same company.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'RideMesh Company' })).toBeVisible();
    await signIn(page, email);
    await expect(page.getByTestId('company-name')).toHaveText('Journey Ltd');
  });

  test('explains mistakes next to the fields before sending anything', async ({ page }) => {
    await open(page, '/sign-up');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Enter your full name.')).toBeVisible();
    await expect(page.getByText('Enter a valid email address.')).toBeVisible();
    await expect(page.getByText('Use at least 8 characters.', { exact: true })).toBeVisible();

    await page.getByLabel('Your full name').fill('Mia Mismatch');
    await page.getByLabel('Work email').fill(uniqueEmail('console-mismatch'));
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill('something-else-entirely');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('The passwords do not match.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toHaveCount(0);

    await open(page, '/sign-in');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Enter your password.')).toBeVisible();
  });

  test('asks for the company details properly', async ({ page }) => {
    const email = uniqueEmail('console-details');
    await signUp(page, 'Dana Details', email);
    await clickVerificationLink(email);
    await page.getByRole('button', { name: 'I have verified my email' }).click();
    await expect(page.getByRole('heading', { name: 'Create your company' })).toBeVisible();

    await page.getByLabel('Company name').fill('A');
    await page.getByLabel('Your full name').fill('');
    await page.getByLabel('Phone (optional)').fill('not a phone');
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.getByText('Enter your company name (at least 2 characters).')).toBeVisible();
    await expect(page.getByText('Enter your full name.')).toBeVisible();
    await expect(page.getByText('Enter a valid phone number, or leave it empty.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Overview' })).toHaveCount(0);

    await page.getByLabel('Company name').fill('Details Ltd');
    await page.getByLabel('Your full name').fill('Dana Details');
    await page.getByLabel('Phone (optional)').fill('+44 20 7946 0958');
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.getByTestId('company-name')).toHaveText('Details Ltd');
  });

  test('picks up again where an unfinished sign-up stopped', async ({ page }) => {
    const email = uniqueEmail('console-resume');
    await signUp(page, 'Rex Resume', email);
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
    await page.getByRole('button', { name: 'Use a different account' }).click();
    await expect(page.getByRole('heading', { name: 'RideMesh Company' })).toBeVisible();

    // The same details again resume the same account instead of failing.
    await signUp(page, 'Rex Resume', email);
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  });

  test('sends a password reset without revealing which emails have accounts', async ({ page }) => {
    const known = uniqueEmail('console-reset');
    await createAccount(known, null, true, 'Reset Person');
    await open(page, '/sign-in');
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();

    for (const email of [known, uniqueEmail('console-nobody')]) {
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByRole('button', { name: 'Send reset link' }).click();
      await expect(page.getByText('If that email belongs to an account')).toBeVisible();
    }
    expect(await resetCodeFor(known)).toBeTruthy();
  });
});

test.describe('everyone else is turned away', () => {
  const others = [
    ['a passenger', { role: 'PASSENGER' }],
    ['a driver', { role: 'DRIVER' }],
    ['platform staff', { role: 'ADMIN' }],
    ['an ordinary employee', { role: 'EMPLOYEE', companyId: 'c1', companyRole: 'EMPLOYEE' }],
  ] as const;

  for (const [label, claims] of others) {
    test(`refuses ${label} at sign-in`, async ({ page }) => {
      const email = uniqueEmail('console-refused');
      await createAccount(email, claims.role, true, 'Someone Else');
      await setClaims(email, claims);

      await signIn(page, email);
      await expect(page.getByText(REFUSAL)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'RideMesh Company' })).toBeVisible();

      // Nothing behind the door opened.
      await page.goto(CONSOLE_URL);
      await expect(page.getByRole('heading', { name: 'RideMesh Company' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Overview' })).toHaveCount(0);
    });
  }

  test('refuses a passenger who tries to sign up with their email, and signs them out', async ({
    page,
  }) => {
    const email = uniqueEmail('console-passenger-signup');
    await createAccount(email, 'PASSENGER', true, 'Pat Passenger');
    await signUp(page, 'Pat Passenger', email);
    await expect(
      page.getByText('An account with this email address already exists.'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toHaveCount(0);
    await page.goto(CONSOLE_URL);
    await expect(page.getByRole('heading', { name: 'RideMesh Company' })).toBeVisible();
  });

  test('shows the server refusal when an administrator is no longer one', async ({ page }) => {
    // The token still says administrator, but there is no such membership: the server decides.
    const email = uniqueEmail('console-stale');
    await createAccount(email, 'EMPLOYEE', true, 'Stale Admin');
    await setClaims(email, {
      role: 'EMPLOYEE',
      companyId: 'no-such-company',
      companyRole: 'COMPANY_ADMIN',
    });

    await signIn(page, email);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Only a company administrator can do this.' }),
    ).toBeVisible();
    await expect(page.getByTestId('tile-employees')).toHaveCount(0);
  });

  test('keeps a signed-out visitor on the sign-in pages', async ({ page }) => {
    for (const path of ['/', '/create-company', '/verify-email', '/anything']) {
      await page.goto(`${CONSOLE_URL}${path}`);
      await expect(page.getByRole('heading', { name: 'RideMesh Company' })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/sign-in');
    }
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the menu opens and closes, and no page scrolls sideways', async ({ page }) => {
    await founderOnOverview(page, 'Phone Ltd');

    const sideways = () => page.evaluate<boolean>(SCROLLS_SIDEWAYS);
    expect(await sideways()).toBe(false);

    const menu = page.getByRole('complementary', { name: 'Menu' });
    await expect(menu).not.toBeInViewport();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(menu).toBeInViewport();
    await page.getByRole('button', { name: 'Close menu' }).click();
    await expect(menu).not.toBeInViewport();

    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'RideMesh Company' })).toBeVisible();
    expect(await sideways()).toBe(false);
  });

  test('every entry page fits the screen', async ({ page }) => {
    for (const path of ['/sign-in', '/sign-up', '/reset-password']) {
      await open(page, path);
      await expect(page.getByRole('heading').first()).toBeVisible();
      expect(await page.evaluate<boolean>(SCROLLS_SIDEWAYS), path).toBe(false);
    }
  });
});

test.describe('accessibility', () => {
  test('the entry pages have no automatically detectable problems', async ({ page }) => {
    for (const path of ['/sign-in', '/sign-up', '/reset-password']) {
      await open(page, path);
      await expect(page.getByRole('heading').first()).toBeVisible();
      await expectNoAccessibilityViolations(page);
    }
  });

  test('the verification, company and overview screens have none either', async ({ page }) => {
    const email = uniqueEmail('console-axe');
    await signUp(page, 'Axel Axe', email);
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await clickVerificationLink(email);
    await page.getByRole('button', { name: 'I have verified my email' }).click();
    await expect(page.getByRole('heading', { name: 'Create your company' })).toBeVisible();
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.getByText('Enter your company name')).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await page.getByLabel('Company name').fill('Axe Ltd');
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.getByTestId('company-name')).toHaveText('Axe Ltd');
    await expectNoAccessibilityViolations(page);
  });

  test('a form can be completed with the keyboard alone', async ({ page }) => {
    const email = uniqueEmail('console-keyboard');
    await open(page, '/sign-up');
    await page.getByLabel('Your full name').focus();
    await page.keyboard.type('Kim Keyboard');
    await page.keyboard.press('Tab');
    await page.keyboard.type(email);
    await page.keyboard.press('Tab');
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Tab');
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  });
});
