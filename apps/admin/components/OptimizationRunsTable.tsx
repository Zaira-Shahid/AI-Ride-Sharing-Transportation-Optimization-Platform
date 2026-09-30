'use client';

import { describeAuthError, listOptimizationRuns } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import type { OptimizationRunDecision, OptimizationRunRow } from '@ridemesh/types';
import { useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';

function formatTime(millis: number): string {
  return millis > 0 ? new Date(millis).toLocaleString() : '—';
}

function formatDistance(meters: number | null): string {
  if (meters === null) return '—';
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const minutes = Math.round(seconds / 60);
  return minutes > 0 ? `${minutes} min` : `${Math.round(seconds)} s`;
}

/**
 * Module 11.9 (admin dashboard: optimization monitoring). Every batch-optimization cycle (the
 * scheduled/immediate matching runs, Module 8.1's own phase 1 - phase 2's simpler insertion heuristic
 * never calls the optimizer, so it has no cycle to show here), newest first. No compatibility score or
 * passenger-walking distance: neither is a real number this system computes, so neither is shown -
 * every number here comes from what the optimizer and the batch run itself actually did.
 */
export function OptimizationRunsTable() {
  const { client } = useAuth();
  const [rows, setRows] = useState<OptimizationRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await listOptimizationRuns(client);
        if (!cancelled) setRows(result);
      } catch (caught) {
        if (!cancelled) setError(describeAuthError(caught).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (error) {
    return <EmptyState title="Could not load optimization runs" description={error} />;
  }
  if (!rows) {
    return <p className="text-sm text-clean-white/60">Loading…</p>;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No optimization runs yet"
        description="A cycle that evaluated at least one open request and one available journey will appear here (the last 500, or 30 days, whichever is fewer)."
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-clean-white/50">
        Showing the last {rows.length} run{rows.length === 1 ? '' : 's'} (capped at 500, or 30
        days).
      </p>
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase tracking-wide text-clean-white/50">
            <tr>
              <th className="px-4 py-3 font-medium">Started</th>
              <th className="px-4 py-3 font-medium">Requests</th>
              <th className="px-4 py-3 font-medium">Journeys</th>
              <th className="px-4 py-3 font-medium">Candidates</th>
              <th className="px-4 py-3 font-medium">Plans</th>
              <th className="px-4 py-3 font-medium">Rejected</th>
              <th className="px-4 py-3 font-medium">Assigned</th>
              <th className="px-4 py-3 font-medium">Execution</th>
              <th className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const open = expanded === row.runId;
              return (
                <RunRow
                  key={row.runId}
                  row={row}
                  open={open}
                  onToggle={() => setExpanded(open ? null : row.runId)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RunRow({
  row,
  open,
  onToggle,
}: {
  row: OptimizationRunRow;
  open: boolean;
  onToggle: () => void;
}) {
  const unmatchedEntries = Object.entries(row.unmatchedByReason);
  return (
    <>
      <tr className="border-b border-white/5 last:border-0">
        <td className="px-4 py-3 align-top text-clean-white/70">{formatTime(row.startedAt)}</td>
        <td className="px-4 py-3 align-top text-clean-white">{row.requestsEvaluated}</td>
        <td className="px-4 py-3 align-top text-clean-white">{row.journeysEvaluated}</td>
        <td className="px-4 py-3 align-top text-clean-white">{row.candidatesGenerated}</td>
        <td className="px-4 py-3 align-top text-clean-white">{row.plansGenerated}</td>
        <td className="px-4 py-3 align-top text-clean-white/70">{row.plansRejected}</td>
        <td className="px-4 py-3 align-top text-clean-white">
          {row.finalAssignments}
          <span className="text-clean-white/50"> / {row.journeysMatched} journeys</span>
        </td>
        <td className="px-4 py-3 align-top text-clean-white/70">
          {row.executionTimeSeconds.toFixed(2)} s
        </td>
        <td className="px-4 py-3 align-top">
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="rounded-md border border-white/10 px-2 py-1 text-xs text-clean-white/70 hover:text-clean-white"
          >
            {open ? 'Hide' : 'Details'}
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-white/5 bg-white/5">
          <td colSpan={9} className="px-4 py-3 text-sm">
            <div className="space-y-4">
              {unmatchedEntries.length > 0 ? (
                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-clean-white/50">
                    Unmatched, by reason
                  </p>
                  <p className="text-clean-white/80">
                    {unmatchedEntries.map(([reason, count]) => `${reason}: ${count}`).join(', ')}
                  </p>
                </div>
              ) : null}
              {row.decisions.length > 0 ? (
                <div className="overflow-x-auto">
                  <p className="mb-1 text-xs uppercase tracking-wide text-clean-white/50">
                    Per-request decisions
                  </p>
                  <table className="w-full text-left text-xs">
                    <thead className="text-clean-white/50">
                      <tr>
                        <th className="px-2 py-1 font-medium">Request</th>
                        <th className="px-2 py-1 font-medium">Status</th>
                        <th className="px-2 py-1 font-medium">Driver</th>
                        <th className="px-2 py-1 font-medium">Added distance</th>
                        <th className="px-2 py-1 font-medium">Added time</th>
                        <th className="px-2 py-1 font-medium">Seats used</th>
                        <th className="px-2 py-1 font-medium">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {row.decisions.map((decision) => (
                        <DecisionRow key={decision.requestId} decision={decision} />
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-clean-white/50">No candidates fit within anyone's limits.</p>
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DecisionRow({ decision }: { decision: OptimizationRunDecision }) {
  return (
    <tr className="border-t border-white/5">
      <td className="px-2 py-1 align-top text-clean-white/80">{decision.requestId}</td>
      <td className="px-2 py-1 align-top text-clean-white">{decision.status}</td>
      <td className="px-2 py-1 align-top text-clean-white/70">{decision.driverId ?? '—'}</td>
      <td className="px-2 py-1 align-top text-clean-white/70">
        {formatDistance(decision.additionalDistanceMeters)}
      </td>
      <td className="px-2 py-1 align-top text-clean-white/70">
        {formatDuration(decision.additionalDurationSeconds)}
      </td>
      <td className="px-2 py-1 align-top text-clean-white/70">
        {decision.seatsUsed !== null && decision.seatsAvailable !== null
          ? `${decision.seatsUsed} / ${decision.seatsAvailable}`
          : '—'}
      </td>
      <td className="px-2 py-1 align-top text-clean-white/60">{decision.reason}</td>
    </tr>
  );
}
