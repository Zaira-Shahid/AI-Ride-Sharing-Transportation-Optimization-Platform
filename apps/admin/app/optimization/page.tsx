import { OptimizationRunsTable } from '../../components/OptimizationRunsTable';
import { PageShell } from '../../components/PageShell';

export default function OptimizationPage() {
  return (
    <PageShell title="Optimization">
      <OptimizationRunsTable />
    </PageShell>
  );
}
