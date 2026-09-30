// Phase 13 (AI/ML). See functions/src/mlPredictions.ts's own header comment for the scope and the
// hard boundary: both prototype models are trained on SYNTHETIC data only, and these types exist
// only for the admin dashboard's own "AI Predictions" page - visibility and demonstration, never a
// real matching, payment or notification decision.

export interface MlStatus {
  prototype: true;
  trainedOn: 'synthetic_data';
  trainedAt: string;
  trainedRowCount: number;
  dataSource: string;
  etaValidationMeanAbsoluteErrorSeconds: number;
  cancellationValidationAuc: number;
  warning: string;
}

export interface MlPredictionInput {
  distanceKm: number;
  hourOfDay: number;
  dayOfWeek: number;
  naiveDurationSeconds: number;
}

export interface EtaPrediction {
  predictedDurationSeconds: number;
  prototype: true;
  trainedOn: 'synthetic_data';
}

export interface CancellationPrediction {
  cancellationRisk: number;
  prototype: true;
  trainedOn: 'synthetic_data';
}
