import { VehiclesTable } from '../../components/VehiclesTable';
import { PageShell } from '../../components/PageShell';

export default function VehiclesPage() {
  return (
    <PageShell title="Vehicles">
      <VehiclesTable />
    </PageShell>
  );
}
