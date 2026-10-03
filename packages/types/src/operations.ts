// Phase 14 (Monitoring). See functions/src/opsCounters.ts's own comment for what is counted and what
// cannot be - this type mirrors what getOperationsSummary actually returns.

/** One stretch of days, added up. */
export interface OperationsPeriod {
  fromDay: string;
  toDay: string;
  routeUnavailable: number;
  routeBusy: number;
  /** Caught exceptions per function or sweep name. */
  functionFailures: Record<string, number>;
}

export interface OperationsDay {
  day: string;
  routeUnavailable: number;
  routeBusy: number;
  functionFailures: number;
}

export interface OperationsSummary {
  generatedAt: number;
  /** The UTC day so far. Not a trailing 24 hours: counters are per day. */
  today: OperationsPeriod;
  /** Today and the six UTC days before it. */
  last7Days: OperationsPeriod;
  /** The same seven days, oldest first. */
  days: OperationsDay[];
  retentionDays: number;
}
