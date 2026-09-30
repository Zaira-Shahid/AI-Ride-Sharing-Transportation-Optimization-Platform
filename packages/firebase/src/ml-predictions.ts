import type {
  CancellationPrediction,
  EtaPrediction,
  MlPredictionInput,
  MlStatus,
} from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

// Phase 13 (AI/ML). Both prototype models are trained on SYNTHETIC data only - see
// functions/src/mlPredictions.ts's own header comment for the full boundary. This wraps the three
// callables the admin dashboard's own "AI Predictions" page reads/demonstrates through; nothing
// else in this codebase should ever import this file.

function translate(error: unknown, message: string): never {
  if (getErrorCode(error) === 'functions/permission-denied') {
    throw new AuthFlowError('permission', message);
  }
  throw error;
}

export async function getMlStatus(client: Pick<FirebaseClient, 'functions'>): Promise<MlStatus> {
  try {
    const result = await httpsCallable<undefined, MlStatus>(client.functions, 'getMlStatus')();
    return result.data;
  } catch (error) {
    translate(error, 'You are not allowed to view AI predictions.');
  }
}

export async function predictEta(
  client: Pick<FirebaseClient, 'functions'>,
  input: MlPredictionInput,
): Promise<EtaPrediction> {
  try {
    const result = await httpsCallable<MlPredictionInput, EtaPrediction>(
      client.functions,
      'predictEta',
    )(input);
    return result.data;
  } catch (error) {
    translate(error, 'You are not allowed to view AI predictions.');
  }
}

export async function predictCancellationRisk(
  client: Pick<FirebaseClient, 'functions'>,
  input: MlPredictionInput,
): Promise<CancellationPrediction> {
  try {
    const result = await httpsCallable<MlPredictionInput, CancellationPrediction>(
      client.functions,
      'predictCancellationRisk',
    )(input);
    return result.data;
  } catch (error) {
    translate(error, 'You are not allowed to view AI predictions.');
  }
}
