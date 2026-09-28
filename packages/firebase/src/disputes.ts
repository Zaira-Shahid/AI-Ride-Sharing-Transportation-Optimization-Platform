import type {
  MarkDisputeReviewedInput,
  MarkDisputeReviewedResult,
  TripMonitoringRow,
} from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

// Module 11.7 (admin dashboard: disputes). Reuses tripMonitoring.ts's own getTripDetail for the
// exact-place detail view (nothing new needed there) - these two calls are this module's own new
// pieces: the disputed-trips list, and the "mark reviewed" work-queue marker.

export interface DisputedTripRow extends TripMonitoringRow {
  disputeReviewed: boolean;
}

function translate(error: unknown): never {
  if (getErrorCode(error) === 'functions/permission-denied') {
    throw new AuthFlowError('permission', 'You are not allowed to view disputes.');
  }
  throw error;
}

/** Every trip whose payment is currently DISPUTED, newest first. */
export async function listDisputedTrips(
  client: Pick<FirebaseClient, 'functions'>,
): Promise<DisputedTripRow[]> {
  try {
    const result = await httpsCallable<undefined, DisputedTripRow[]>(
      client.functions,
      'listDisputedTrips',
    )();
    return result.data;
  } catch (error) {
    translate(error);
  }
}

/** Marks a disputed trip as looked at - a work-queue marker only, never a payment state change. */
export async function markDisputeReviewed(
  client: Pick<FirebaseClient, 'functions'>,
  tripId: string,
): Promise<MarkDisputeReviewedResult['status']> {
  try {
    const result = await httpsCallable<MarkDisputeReviewedInput, MarkDisputeReviewedResult>(
      client.functions,
      'markDisputeReviewed',
    )({ tripId });
    return result.data.status;
  } catch (error) {
    translate(error);
  }
}
