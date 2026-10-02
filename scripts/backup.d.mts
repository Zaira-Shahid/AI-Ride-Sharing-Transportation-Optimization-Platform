// Types for scripts/backup.mjs, so the tests can import it.
export interface BackupStep {
  description: string;
  args: string[];
}
export interface BackupPlan {
  title: string;
  steps: BackupStep[];
}
export interface BackupOptions {
  project?: string | undefined;
  file?: string | undefined;
  backup?: string | undefined;
  into?: string | undefined;
  at?: string | undefined;
  location?: string | undefined;
}
export const BACKUP_SETTINGS: {
  database: string;
  recurrence: string;
  retention: string;
  pointInTimeRecovery: string;
  deleteProtection: string;
};
export const PITR_WINDOW_DAYS: number;
export const ACTIONS: string[];
export function defaultProject(rootDir?: string): string | undefined;
export function buildPlan(action: string, options?: BackupOptions, now?: number): BackupPlan;
export function quoteArg(arg: string, platform?: string): string;
export function formatCommand(step: BackupStep, platform?: string): string;
export function checkRunAllowed(flags: Set<string>): void;
