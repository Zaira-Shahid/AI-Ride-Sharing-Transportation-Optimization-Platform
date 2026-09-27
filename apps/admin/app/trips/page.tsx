import { TripsTable } from '../../components/TripsTable';
import { PageShell } from '../../components/PageShell';

export default function TripsPage() {
  return (
    <PageShell title="Trips">
      <TripsTable />
    </PageShell>
  );
}
