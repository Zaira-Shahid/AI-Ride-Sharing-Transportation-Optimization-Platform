// Where each kind of visitor may be (module A4a, docs/a4-company-dashboard-design.md). A pure
// function, so every combination can be tested without a browser: the gate redirects to what this
// returns, and renders the page when it returns null.

export type ConsoleStatus =
  'loading' | 'signedOut' | 'unverified' | 'needsCompany' | 'admin' | 'refused';

export const SIGN_IN = '/sign-in';
export const SIGN_UP = '/sign-up';
export const RESET_PASSWORD = '/reset-password';
export const VERIFY_EMAIL = '/verify-email';
export const CREATE_COMPANY = '/create-company';
export const HOME = '/';

/** Pages a person can open before they are an administrator. */
const SIGNED_OUT_PAGES: readonly string[] = [SIGN_IN, SIGN_UP, RESET_PASSWORD];
const ENTRY_PAGES: readonly string[] = [...SIGNED_OUT_PAGES, VERIFY_EMAIL, CREATE_COMPANY];

/** The page to send the visitor to, or null when they are already where they may be. */
export function redirectFor(status: ConsoleStatus, pathname: string): string | null {
  switch (status) {
    case 'loading':
    case 'refused':
      return null;
    case 'signedOut':
      return SIGNED_OUT_PAGES.includes(pathname) ? null : SIGN_IN;
    case 'unverified':
      return pathname === VERIFY_EMAIL ? null : VERIFY_EMAIL;
    case 'needsCompany':
      return pathname === CREATE_COMPANY ? null : CREATE_COMPANY;
    case 'admin':
      return ENTRY_PAGES.includes(pathname) ? HOME : null;
  }
}
