export interface NavItem {
  slug: string;
  label: string;
  href: string;
}

const sections = [
  ['live-network', 'Live Network'],
  ['trips', 'Trips'],
  ['drivers', 'Drivers'],
  ['passengers', 'Passengers'],
  ['vehicles', 'Vehicles'],
  ['optimization', 'Optimization'],
  ['payments', 'Payments'],
  ['disputes', 'Disputes'],
  ['safety', 'Safety'],
  ['analytics', 'Analytics'],
  ['system-settings', 'System Settings'],
  ['audit-logs', 'Audit Logs'],
] as const;

export const OVERVIEW_ITEM: NavItem = { slug: 'overview', label: 'Overview', href: '/' };

export const SECTION_ITEMS: NavItem[] = sections.map(([slug, label]) => ({
  slug,
  label,
  href: `/${slug}`,
}));

export const NAV_ITEMS: NavItem[] = [OVERVIEW_ITEM, ...SECTION_ITEMS];
