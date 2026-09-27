import type {
  GetTripDetailInput,
  ListTripHistoryInput,
  ListTripHistoryResult,
  TripDetailForStaff,
  TripHistoryCursor,
  TripMonitoringRow,
} from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

// Module 11.4 (admin dashboard: trip monitoring). Unlike listDriversForReview/listPassengersForReview,
// these are NOT direct Firestore reads - tripRequests has no staff read rule at all (docs/security.md:
// "staff access will come through audited functions... not a blanket read rule"), so every one of
// these calls the corresponding functions/src/tripMonitoring.ts callable.

function translate(error: unknown): never {
  if (getErrorCode(error) === 'functions/permission-denied') {
    throw new AuthFlowError('permission', 'You are not allowed to view trips.');
  }
  throw error;
}

/** Every currently-open trip, newest first - the live view. Re-fetch to refresh; not a subscription. */
export async function listActiveTrips(
  client: Pick<FirebaseClient, 'functions'>,
): Promise<TripMonitoringRow[]> {
  try {
    const result = await httpsCallable<undefined, TripMonitoringRow[]>(
      client.functions,
      'listActiveTrips',
    )();
    return result.data;
  } catch (error) {
    translate(error);
  }
}

/** One page of completed/cancelled trips, newest first. Pass the previous result's cursor to page on. */
export async function listTripHistory(
  client: Pick<FirebaseClient, 'functions'>,
  cursor: TripHistoryCursor | null = null,
): Promise<ListTripHistoryResult> {
  try {
    const result = await httpsCallable<ListTripHistoryInput, ListTripHistoryResult>(
      client.functions,
      'listTripHistory',
    )({ cursor });
    return result.data;
  } catch (error) {
    translate(error);
  }
}

/** One trip's full detail, including its exact places. Every call audits a staff view - see the module comment. */
export async function getTripDetail(
  client: Pick<FirebaseClient, 'functions'>,
  tripId: string,
): Promise<TripDetailForStaff> {
  try {
    const result = await httpsCallable<GetTripDetailInput, TripDetailForStaff>(
      client.functions,
      'getTripDetail',
    )({ tripId });
    return result.data;
  } catch (error) {
    translate(error);
  }
}
