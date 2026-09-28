import { notFound } from 'next/navigation';
import { EmptyState } from '../../components/EmptyState';
import { PageShell } from '../../components/PageShell';
import { SECTION_ITEMS } from '../../lib/navigation';

export const dynamicParams = false;

// Module 11.2 (driver/vehicle management), 11.3 (user management), 11.4 (trip monitoring), 11.5
// (live map), 11.6 (vehicle management, standalone page), 11.7 (disputes) and 11.8 (audit logs):
// 'drivers'/'passengers'/'trips'/'live-network'/'vehicles'/'disputes'/'audit-logs' each have their
// own real page now (app/drivers/page.tsx, app/passengers/page.tsx, app/trips/page.tsx,
// app/live-network/page.tsx, app/vehicles/page.tsx, app/disputes/page.tsx,
// app/audit-logs/page.tsx) - they must stay out of this catch-all's own static
// params, or Next.js's build sees two pages resolving the same path and refuses to build. Still in
// SECTION_ITEMS (so the sidebar's own link is unaffected) - only excluded from what this placeholder
// generates.
const SECTIONS_WITH_OWN_PAGE = new Set([
  'drivers',
  'passengers',
  'trips',
  'live-network',
  'vehicles',
  'disputes',
  'audit-logs',
]);

export function generateStaticParams() {
  return SECTION_ITEMS.filter((item) => !SECTIONS_WITH_OWN_PAGE.has(item.slug)).map((item) => ({
    section: item.slug,
  }));
}

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const item = SECTION_ITEMS.find((candidate) => candidate.slug === section);
  if (!item) notFound();

  return (
    <PageShell title={item.label}>
      <EmptyState
        title={`No ${item.label.toLowerCase()} data yet`}
        description="This section will populate as the network becomes active."
      />
    </PageShell>
  );
}
