import { EmptyState } from '../components/EmptyState';
import { PageShell } from '../components/PageShell';

export default function OverviewPage() {
  return (
    <PageShell title="Overview">
      <EmptyState
        title="No network data yet"
        description="Network metrics will appear here once drivers and passengers are active."
      />
    </PageShell>
  );
}
