import { PassengersTable } from '../../components/PassengersTable';
import { PageShell } from '../../components/PageShell';

export default function PassengersPage() {
  return (
    <PageShell title="Passengers">
      <PassengersTable />
    </PageShell>
  );
}
