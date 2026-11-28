import { z } from 'zod';
import { COMPANY_NAME_MAX } from './onboarding';
import { DECLINE_WINDOW_MAX_MINUTES, DECLINE_WINDOW_MIN_MINUTES } from './decline';

// Inputs, limits and results for the company dashboard's own functions (module A4a,
// docs/a4-company-dashboard-design.md). Mirrored in functions/src/companyDashboard.ts;
// tests/tenancy-parity.test.ts fails if they diverge.

export const SETTINGS_CHANGES_PER_ADMIN_PER_HOUR = 30;

export const updateCompanySettingsInputSchema = z
  .object({
    name: z.string().trim().min(2).max(COMPANY_NAME_MAX).nullish(),
    driverDeclineWindowMinutes: z
      .number()
      .int()
      .min(DECLINE_WINDOW_MIN_MINUTES)
      .max(DECLINE_WINDOW_MAX_MINUTES)
      .nullish(),
  })
  // The Firebase client sends null for a field left undefined, so null means "leave it".
  .refine((value) => value.name != null || value.driverDeclineWindowMinutes != null);
export type UpdateCompanySettingsInput = z.infer<typeof updateCompanySettingsInputSchema>;

export interface UpdateCompanySettingsResult {
  status: 'updated' | 'unchanged';
  name: string;
  driverDeclineWindowMinutes: number;
}

/** What the company's administrator sees on the overview. Counts only: nothing about trips or places. */
export interface CompanyOverview {
  companyName: string;
  /** Active members, administrators included. */
  employees: number;
  /** Invitations that can still be accepted. */
  pendingInvitations: number;
  /** Employees who applied to drive and have not been decided on. */
  driverApplications: number;
  /** Active members the administrators have approved to drive. */
  approvedDrivers: number;
}
