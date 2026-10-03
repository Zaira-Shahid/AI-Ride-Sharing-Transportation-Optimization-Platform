'use client';

import { describeAuthError, getOperationsSummary } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import type { OperationsPeriod, OperationsSummary } from '@ridemesh/types';
import { useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';

function Tile({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="rounded-xl border border-white/10 p-4">
      <p className="text-xs uppercase tracking-wide text-clean-white/50">{label}</p>
      <p className="mt-1 text-xl font-semibold text-clean-white">{value.toLocaleString('en-GB')}</p>
      {note ? <p className="mt-1 text-xs text-clean-white/50">{note}</p> : null}
    </div>
  );
}

const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

function Period({ title, period }: { title: string; period: OperationsPeriod }) {
  const names = Object.keys(period.functionFailures).sort(
    (a, b) => (period.functionFailures[b] ?? 0) - (period.functionFailures[a] ?? 0),
  );
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-clean-white/70">
        {title}{' '}
        <span className="text-clean-white/40">
          (
          {period.fromDay === period.toDay
            ? period.fromDay
            : `${period.fromDay} to ${period.toDay}`}
          , UTC days)
        </span>
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile
          label="Route lookups unavailable"
          value={period.routeUnavailable}
          note="The routing server failed or did not answer"
        />
        <Tile
          label="Route lookups busy"
          value={period.routeBusy}
          note="Refused by the usage limits - normal limiting, not a fault"
        />
        <Tile
          label="Function failures"
          value={total(period.functionFailures)}
          note="Exceptions a trigger or sweep caught"
        />
      </div>
      {names.length > 0 ? (
        <table className="mt-3 w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-clean-white/50">
            <tr>
              <th className="py-1 pr-4 font-medium">Function</th>
              <th className="py-1 font-medium">Failures</th>
            </tr>
          </thead>
          <tbody>
            {names.map((name) => (
              <tr key={name} className="border-t border-white/10">
                <td className="py-1 pr-4 text-clean-white">{name}</td>
                <td className="py-1 text-clean-white">{period.functionFailures[name]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

/**
 * Phase 14 (Monitoring). Counts of route lookups that gave no route and of exceptions the Cloud
 * Function triggers and sweeps caught, for today and the last seven UTC days (functions/src/
 * opsCounters.ts). Counts and kinds only - never who or where. Any staff role may view this page.
 * The limits are said on the page itself, because a zero here must not be read as "nothing is wrong".
 */
export function OperationsView() {
  const { client } = useAuth();
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getOperationsSummary(client)
      .then(setSummary)
      .catch((caught) => setError(describeAuthError(caught).message));
  }, [client]);

  if (error) {
    return <EmptyState title="Could not load operations" description={error} />;
  }
  if (!summary) {
    return <p className="text-sm text-clean-white/60">Loading…</p>;
  }

  return (
    <div className="space-y-6">
      <p
        role="note"
        className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-clean-white/80"
      >
        These are counts of failures the system caught and counted itself. A function that crashes,
        runs out of memory or times out never reaches the code that counts, so it is not here: look
        in Cloud Logging and Cloud Monitoring for those. Counting is best effort, so a count can be
        missed but never invented. A lookup is counted each time it is refused or fails, so one
        request that is refused four times counts four. Routes with no road route are not counted.
        Counts are kept {summary.retentionDays} days.
      </p>
      <Period title="Today" period={summary.today} />
      <Period title="Last 7 days" period={summary.last7Days} />
      <section>
        <h2 className="mb-2 text-sm font-medium text-clean-white/70">Day by day</h2>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-clean-white/50">
            <tr>
              <th className="py-1 pr-4 font-medium">Day (UTC)</th>
              <th className="py-1 pr-4 font-medium">Unavailable</th>
              <th className="py-1 pr-4 font-medium">Busy</th>
              <th className="py-1 font-medium">Function failures</th>
            </tr>
          </thead>
          <tbody>
            {[...summary.days].reverse().map((day) => (
              <tr key={day.day} className="border-t border-white/10">
                <td className="py-1 pr-4 text-clean-white">{day.day}</td>
                <td className="py-1 pr-4 text-clean-white">{day.routeUnavailable}</td>
                <td className="py-1 pr-4 text-clean-white">{day.routeBusy}</td>
                <td className="py-1 text-clean-white">{day.functionFailures}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
