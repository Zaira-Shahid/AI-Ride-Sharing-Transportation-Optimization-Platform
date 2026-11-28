'use client';

import { describeAuthError, type AuthFailure } from '@ridemesh/firebase';
import { getCompanyOverview } from '@ridemesh/firebase/company';
import { useAuth } from '@ridemesh/firebase/react';
import type { CompanyOverview } from '@ridemesh/tenancy';
import { useCallback, useEffect, useState } from 'react';
import { overviewTiles } from '../lib/overview';
import { secondaryButtonClass } from '../lib/ui';
import { PageShell } from './PageShell';

type State =
  | { status: 'loading' }
  | { status: 'ready'; overview: CompanyOverview }
  | { status: 'error'; failure: AuthFailure };

/** The overview: the company's name and four counts. Nothing about trips or places. */
export function OverviewView() {
  const { client } = useAuth();
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', overview: await getCompanyOverview(client) });
    } catch (error) {
      setState({ status: 'error', failure: describeAuthError(error) });
    }
  }, [client]);

  useEffect(() => {
    // Starting the load from an effect is the point: it is how this page fetches its data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <PageShell title="Overview">
      {state.status === 'loading' ? (
        <p role="status" className="text-clean-white/70">
          Loading…
        </p>
      ) : null}

      {state.status === 'error' ? (
        <div role="alert" className="max-w-md space-y-3">
          <p className="rounded-md bg-danger-red/10 px-3 py-2 text-sm text-danger-text">
            {state.failure.message}
          </p>
          {state.failure.retryable ? (
            <button type="button" onClick={() => void load()} className={secondaryButtonClass}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}

      {state.status === 'ready' ? (
        <section aria-label="Company overview" className="space-y-6">
          <p data-testid="company-name" className="text-lg text-clean-white/80">
            {state.overview.companyName}
          </p>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {overviewTiles(state.overview).map((tile) => (
              <li
                key={tile.key}
                data-testid={`tile-${tile.key}`}
                className="rounded-xl border border-white/10 bg-deep-slate p-5"
              >
                <h2 className="text-sm text-clean-white/70">{tile.label}</h2>
                <p className="mt-2 text-3xl font-semibold tracking-tight">{tile.value}</p>
                <p className="mt-2 text-xs text-clean-white/60">{tile.hint}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </PageShell>
  );
}
