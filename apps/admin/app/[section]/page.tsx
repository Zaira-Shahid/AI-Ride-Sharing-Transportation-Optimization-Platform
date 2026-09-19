import { notFound } from 'next/navigation';
import { EmptyState } from '../../components/EmptyState';
import { PageShell } from '../../components/PageShell';
import { SECTION_ITEMS } from '../../lib/navigation';

export const dynamicParams = false;

export function generateStaticParams() {
  return SECTION_ITEMS.map((item) => ({ section: item.slug }));
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
