'use client';

import {
  describeAuthError,
  getMlStatus,
  predictCancellationRisk,
  predictEta,
} from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import type {
  CancellationPrediction,
  EtaPrediction,
  MlPredictionInput,
  MlStatus,
} from '@ridemesh/types';
import { useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';

const DEFAULT_INPUT: MlPredictionInput = {
  distanceKm: 8,
  hourOfDay: 8,
  dayOfWeek: 2,
  naiveDurationSeconds: 1152,
};

function formatDuration(seconds: number): string {
  const minutes = seconds / 60;
  return minutes >= 1 ? `${minutes.toFixed(1)} min` : `${Math.round(seconds)} s`;
}

function Field({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm text-clean-white/70">
      {label}
      <input
        type="number"
        className="rounded-md border border-white/15 bg-transparent px-3 py-1.5 text-clean-white"
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

/**
 * Phase 13 (AI/ML). User-confirmed scope: a visibility-only page showing model metadata, the
 * prototype label, validation metrics, and a manual demo-prediction form - it never reads or writes
 * any real trip. THE HARD BOUNDARY (spec section 32, matched exactly): these two models are trained
 * on SYNTHETIC data only (services/optimization/app/ml/__init__.py) and this page's own manual form
 * is the ONLY caller of either prediction endpoint anywhere in this codebase - no real matching,
 * payment or notification decision reads a prediction from here. Any staff role may view this page.
 */
export function AiPredictionsView() {
  const { client } = useAuth();
  const [status, setStatus] = useState<MlStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [input, setInput] = useState<MlPredictionInput>(DEFAULT_INPUT);
  const [eta, setEta] = useState<EtaPrediction | null>(null);
  const [cancellation, setCancellation] = useState<CancellationPrediction | null>(null);
  const [predictError, setPredictError] = useState<string | null>(null);
  const [isPredicting, setIsPredicting] = useState(false);

  useEffect(() => {
    getMlStatus(client)
      .then(setStatus)
      .catch((caught) => setStatusError(describeAuthError(caught).message));
  }, [client]);

  async function handlePredict() {
    setIsPredicting(true);
    setPredictError(null);
    try {
      const [etaResult, cancellationResult] = await Promise.all([
        predictEta(client, input),
        predictCancellationRisk(client, input),
      ]);
      setEta(etaResult);
      setCancellation(cancellationResult);
    } catch (caught) {
      setPredictError(describeAuthError(caught).message);
    } finally {
      setIsPredicting(false);
    }
  }

  if (statusError) {
    return (
      <EmptyState title="Could not load the AI prediction prototype" description={statusError} />
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-amber/40 bg-amber/5 p-4">
        <p className="text-xs uppercase tracking-wide text-amber">
          Prototype - trained and validated on synthetic data only
        </p>
        <p className="mt-2 text-sm text-clean-white/70">
          These models have never seen a real trip and are not production-ready. They do not
          influence any real matching, payment or notification decision - this page is for viewing
          and demonstration only.
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium text-clean-white/70">Model metadata</h2>
        {!status ? (
          <p className="text-sm text-clean-white/60">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-white/10 p-4">
              <p className="text-xs uppercase tracking-wide text-clean-white/50">Data source</p>
              <p className="mt-1 text-sm text-clean-white">{status.dataSource}</p>
            </div>
            <div className="rounded-xl border border-white/10 p-4">
              <p className="text-xs uppercase tracking-wide text-clean-white/50">Trained on</p>
              <p className="mt-1 text-sm text-clean-white">
                {status.trainedRowCount.toLocaleString()} synthetic trips, as of{' '}
                {new Date(status.trainedAt).toLocaleString()}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 p-4">
              <p className="text-xs uppercase tracking-wide text-clean-white/50">
                Validation metrics
              </p>
              <p className="mt-1 text-sm text-clean-white">
                ETA MAE: {status.etaValidationMeanAbsoluteErrorSeconds.toFixed(0)}s · Cancellation
                AUC: {status.cancellationValidationAuc.toFixed(3)}
              </p>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-clean-white/70">Manual demo prediction</h2>
        <p className="mb-3 text-xs text-clean-white/50">
          Enter a hypothetical trip - this does not read or write any real trip.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field
            label="Distance (km)"
            value={input.distanceKm}
            min={0.1}
            max={200}
            step={0.1}
            onChange={(distanceKm) => setInput((current) => ({ ...current, distanceKm }))}
          />
          <Field
            label="Hour of day (0-23)"
            value={input.hourOfDay}
            min={0}
            max={23}
            onChange={(hourOfDay) => setInput((current) => ({ ...current, hourOfDay }))}
          />
          <Field
            label="Day of week (0=Mon)"
            value={input.dayOfWeek}
            min={0}
            max={6}
            onChange={(dayOfWeek) => setInput((current) => ({ ...current, dayOfWeek }))}
          />
          <Field
            label="Naive duration (s)"
            value={input.naiveDurationSeconds}
            min={1}
            max={7200}
            onChange={(naiveDurationSeconds) =>
              setInput((current) => ({ ...current, naiveDurationSeconds }))
            }
          />
        </div>
        <button
          type="button"
          onClick={handlePredict}
          disabled={isPredicting}
          className="mt-4 rounded-md bg-white/10 px-4 py-2 text-sm text-clean-white hover:bg-white/15 disabled:opacity-50"
        >
          {isPredicting ? 'Predicting…' : 'Run prototype prediction'}
        </button>

        {predictError ? <p className="mt-3 text-sm text-red-400">{predictError}</p> : null}

        {(eta || cancellation) && (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {eta ? (
              <div className="rounded-xl border border-white/10 p-4">
                <p className="text-xs uppercase tracking-wide text-clean-white/50">
                  Predicted duration (prototype)
                </p>
                <p className="mt-1 text-xl font-semibold text-clean-white">
                  {formatDuration(eta.predictedDurationSeconds)}
                </p>
              </div>
            ) : null}
            {cancellation ? (
              <div className="rounded-xl border border-white/10 p-4">
                <p className="text-xs uppercase tracking-wide text-clean-white/50">
                  Cancellation risk (prototype)
                </p>
                <p className="mt-1 text-xl font-semibold text-clean-white">
                  {(cancellation.cancellationRisk * 100).toFixed(0)}%
                </p>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
