import { AuditLogsTable } from '../../components/AuditLogsTable';
import { PageShell } from '../../components/PageShell';

export default function AuditLogsPage() {
  return (
    <PageShell title="Audit Logs">
      <AuditLogsTable />
    </PageShell>
  );
}
