import { PaymentsTable } from '../../components/PaymentsTable';
import { PageShell } from '../../components/PageShell';

export default function PaymentsPage() {
  return (
    <PageShell title="Payments">
      <PaymentsTable />
    </PageShell>
  );
}
