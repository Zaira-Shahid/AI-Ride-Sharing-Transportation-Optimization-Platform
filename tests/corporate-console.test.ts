import { describe, expect, it } from 'vitest';
import { validateCreateCompany } from '../apps/corporate/lib/forms';
import { NAV_ITEMS } from '../apps/corporate/lib/navigation';
import { overviewTiles } from '../apps/corporate/lib/overview';
import { redirectFor, type ConsoleStatus } from '../apps/corporate/lib/routing';

// The company console's own logic (module A4a, docs/a4-company-dashboard-design.md), as plain
// functions: who may be on which page, what the forms accept, what the overview says.

const ENTRY_PAGES = ['/sign-in', '/sign-up', '/reset-password', '/verify-email', '/create-company'];
const DASHBOARD_PAGES = ['/', '/employees', '/settings', '/anything-else'];

describe('redirectFor', () => {
  it('sends a signed-out visitor to sign in from every page except the three open ones', () => {
    for (const page of ['/sign-in', '/sign-up', '/reset-password']) {
      expect(redirectFor('signedOut', page), page).toBeNull();
    }
    for (const page of ['/', '/verify-email', '/create-company', '/employees']) {
      expect(redirectFor('signedOut', page), page).toBe('/sign-in');
    }
  });

  it('keeps an unverified account on the verification page', () => {
    expect(redirectFor('unverified', '/verify-email')).toBeNull();
    for (const page of ['/', '/sign-in', '/create-company', '/employees']) {
      expect(redirectFor('unverified', page), page).toBe('/verify-email');
    }
  });

  it('keeps an account with no company on the create-company page', () => {
    expect(redirectFor('needsCompany', '/create-company')).toBeNull();
    for (const page of ['/', '/sign-in', '/verify-email', '/employees']) {
      expect(redirectFor('needsCompany', page), page).toBe('/create-company');
    }
  });

  it('lets an administrator into the dashboard and out of the entry pages', () => {
    for (const page of DASHBOARD_PAGES) expect(redirectFor('admin', page), page).toBeNull();
    for (const page of ENTRY_PAGES) expect(redirectFor('admin', page), page).toBe('/');
  });

  it('never moves a visitor who is still loading or who was refused', () => {
    for (const status of ['loading', 'refused'] as ConsoleStatus[]) {
      for (const page of [...ENTRY_PAGES, ...DASHBOARD_PAGES]) {
        expect(redirectFor(status, page), `${status} ${page}`).toBeNull();
      }
    }
  });

  it('never lets anyone but an administrator reach a dashboard page', () => {
    const dashboardOnly = [...DASHBOARD_PAGES].filter((page) => !ENTRY_PAGES.includes(page));
    for (const status of ['signedOut', 'unverified', 'needsCompany'] as ConsoleStatus[]) {
      for (const page of dashboardOnly) {
        expect(redirectFor(status, page), `${status} ${page}`).not.toBeNull();
      }
    }
  });
});

describe('navigation', () => {
  it('offers only screens that exist', () => {
    expect(NAV_ITEMS.map((item) => item.href)).toEqual(['/']);
  });
});

describe('validateCreateCompany', () => {
  const good = { companyName: 'Acme Ltd', ownerName: 'Ada Lovelace', phone: '' };

  it('accepts good details, trims them, and leaves out an empty phone', () => {
    expect(validateCreateCompany(good)).toEqual({
      ok: true,
      data: { name: 'Acme Ltd', ownerName: 'Ada Lovelace' },
    });
    expect(
      validateCreateCompany({
        companyName: '  Acme  ',
        ownerName: ' Ada ',
        phone: ' +44 20 7946 0958 ',
      }),
    ).toEqual({
      ok: true,
      data: { name: 'Acme', ownerName: 'Ada', phone: '+44 20 7946 0958' },
    });
  });

  it('explains each problem next to its field', () => {
    const result = validateCreateCompany({ companyName: 'A', ownerName: '   ', phone: 'abc' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(['companyName', 'ownerName', 'phone']);
      expect(result.errors.companyName).toMatch(/at least 2/);
      expect(result.errors.ownerName).toMatch(/full name/);
      expect(result.errors.phone).toMatch(/valid phone/);
    }
  });

  it.each([
    ['a name of 100 characters', { ...good, companyName: 'x'.repeat(100) }, true],
    ['a name of 101 characters', { ...good, companyName: 'x'.repeat(101) }, false],
    ['an owner name of 100 characters', { ...good, ownerName: 'x'.repeat(100) }, true],
    ['an owner name of 101 characters', { ...good, ownerName: 'x'.repeat(101) }, false],
    ['a phone with too few digits', { ...good, phone: '123456' }, false],
    ['a phone with 7 digits', { ...good, phone: '1234567' }, true],
    ['a phone with 15 digits', { ...good, phone: '123456789012345' }, true],
    ['a phone with 16 digits', { ...good, phone: '1234567890123456' }, false],
    ['a phone of more than 32 characters', { ...good, phone: `+${'1 '.repeat(20)}` }, false],
  ])('treats %s correctly', (_label, values, ok) => {
    expect(validateCreateCompany(values).ok).toBe(ok);
  });
});

describe('overviewTiles', () => {
  const overview = {
    companyName: 'Acme',
    employees: 1,
    pendingInvitations: 0,
    driverApplications: 0,
    approvedDrivers: 0,
  };

  it('has the four counts in order, and nothing else', () => {
    expect(overviewTiles(overview).map((tile) => [tile.key, tile.value])).toEqual([
      ['employees', 1],
      ['pendingInvitations', 0],
      ['driverApplications', 0],
      ['approvedDrivers', 0],
    ]);
  });

  it('says what to do when the company has just started', () => {
    const tiles = overviewTiles(overview);
    expect(tiles[0]!.hint).toMatch(/Just you/);
    expect(tiles[1]!.hint).toMatch(/No invitations/);
    expect(tiles[2]!.hint).toMatch(/Nobody is waiting/);
    expect(tiles[3]!.hint).toMatch(/No employee is approved/);
  });

  it('uses the singular and the plural correctly', () => {
    const one = overviewTiles({
      ...overview,
      pendingInvitations: 1,
      driverApplications: 1,
      approvedDrivers: 1,
    });
    expect(one[1]!.hint).toBe('1 invitation is waiting to be accepted.');
    expect(one[2]!.hint).toBe('1 employee is waiting for a decision.');
    expect(one[3]!.hint).toBe('1 employee is approved to offer rides.');

    const many = overviewTiles({
      ...overview,
      employees: 5,
      pendingInvitations: 3,
      driverApplications: 2,
      approvedDrivers: 4,
    });
    expect(many[0]!.hint).toMatch(/Active members/);
    expect(many[1]!.hint).toBe('3 invitations are waiting to be accepted.');
    expect(many[2]!.hint).toBe('2 employees are waiting for a decision.');
    expect(many[3]!.hint).toBe('4 employees are approved to offer rides.');
  });
});
