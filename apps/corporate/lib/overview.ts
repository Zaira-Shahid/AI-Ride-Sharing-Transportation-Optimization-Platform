import type { CompanyOverview } from '@ridemesh/tenancy';

// What each overview tile says (module A4a). Plain functions so the wording, including the singular
// and the zero case, can be tested without a browser.

export interface OverviewTile {
  key: 'employees' | 'pendingInvitations' | 'driverApplications' | 'approvedDrivers';
  label: string;
  value: number;
  hint: string;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function overviewTiles(overview: CompanyOverview): OverviewTile[] {
  return [
    {
      key: 'employees',
      label: 'Employees',
      value: overview.employees,
      hint:
        overview.employees === 1
          ? 'Just you so far. Invite your colleagues to get started.'
          : 'Active members of your company, including administrators.',
    },
    {
      key: 'pendingInvitations',
      label: 'Pending invitations',
      value: overview.pendingInvitations,
      hint:
        overview.pendingInvitations === 0
          ? 'No invitations are waiting to be accepted.'
          : `${overview.pendingInvitations} ${plural(overview.pendingInvitations, 'invitation is', 'invitations are')} waiting to be accepted.`,
    },
    {
      key: 'driverApplications',
      label: 'Driver applications',
      value: overview.driverApplications,
      hint:
        overview.driverApplications === 0
          ? 'Nobody is waiting for a decision.'
          : `${overview.driverApplications} ${plural(overview.driverApplications, 'employee is', 'employees are')} waiting for a decision.`,
    },
    {
      key: 'approvedDrivers',
      label: 'Approved drivers',
      value: overview.approvedDrivers,
      hint:
        overview.approvedDrivers === 0
          ? 'No employee is approved to drive yet.'
          : `${overview.approvedDrivers} ${plural(overview.approvedDrivers, 'employee is', 'employees are')} approved to offer rides.`,
    },
  ];
}
