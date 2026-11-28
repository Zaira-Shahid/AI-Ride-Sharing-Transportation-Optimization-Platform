export interface NavItem {
  slug: string;
  label: string;
  href: string;
}

// Each screen is added here in the module that builds it, so the menu never offers a page that does
// not exist yet.
export const NAV_ITEMS: readonly NavItem[] = [{ slug: 'overview', label: 'Overview', href: '/' }];
