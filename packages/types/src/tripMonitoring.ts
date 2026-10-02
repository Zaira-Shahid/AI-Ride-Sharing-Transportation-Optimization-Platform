import { z } from 'zod';

// Module 11.4 (admin dashboard: trip monitoring). docs/security.md is explicit that `tripRequests` is
// never opened to staff by a Firestore rule ("staff access will come through audited functions...
// not a blanket read rule") and that its audit trail "names no place" - this module is exactly that
// audited access point. Scoped via a plain-text exchange with the user (not AskUserQuestion, per their
// own stated preference): (a) a live view of currently-active trips plus a separate paginated history
// view; (b) list views are NOT audited - they show only status/passenger/driver/times/fare, reusing
// the trip request's own already-anonymized passengerName/driverName snapshot fields (first name
// only, Module 5.5/7.3's own design) so no join and no exact place is ever in a list row; (c) a
// SEPARATE getTripDetail callable is the only path to exact origin/destination, and every call audits
// a TRIP_VIEWED_BY_STAFF entry naming the trip, never the place - matching every other trip-related
// audit entry in this codebase.

export const TRIP_HISTORY_PAGE_SIZE = 25;
export const TRIP_MONITORING_HISTORY_STATUSES = ['COMPLETED', 'CANCELLED'] as const;

// Carries the timestamp's full precision (seconds + nanoseconds), not just milliseconds - a page
// boundary cut to milliseconds could skip a trip request created in the same millisecond as the last
// row of a page. Module 11.8's audit-log cursor (auditLogs.ts) uses the same shape for the same reason.
export const tripHistoryCursorSchema = z.object({
  seconds: z.number().int(),
  nanoseconds: z.number().int().min(0).max(999_999_999),
  tripId: z.string().trim().min(1).max(200),
});
export type TripHistoryCursor = z.infer<typeof tripHistoryCursorSchema>;

export const listTripHistoryInputSchema = z.object({
  cursor: tripHistoryCursorSchema.nullish(),
});
export type ListTripHistoryInput = z.infer<typeof listTripHistoryInputSchema>;

export const getTripDetailInputSchema = z.object({
  tripId: z.string().trim().min(1).max(200),
});
export type GetTripDetailInput = z.infer<typeof getTripDetailInputSchema>;

/** One row of a staff trip list - no exact place ever appears here. */
export interface TripMonitoringRow {
  tripId: string;
  status: string;
  passengerName: string;
  driverName: string | null;
  createdAt: number;
  requestedDepartureTime: number;
  finalFareMinorUnits: number | null;
  estimatedFare: number | null;
  paymentStatus: string | null;
  sharedRide: boolean;
}

export interface ListTripHistoryResult {
  rows: TripMonitoringRow[];
  nextCursor: TripHistoryCursor | null;
}

/** A single trip's full detail for staff, including its exact places - only via an audited read. */
export interface TripDetailForStaff extends TripMonitoringRow {
  /** Null once the retention sweep has cleared the places (30 days after the trip ended). */
  origin: { latitude: number; longitude: number; formattedAddress: string } | null;
  destination: { latitude: number; longitude: number; formattedAddress: string } | null;
  estimatedDistance: number | null;
  estimatedDuration: number | null;
  vehicleType: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehiclePlateNumber: string | null;
  authorizedAmountMinorUnits: number | null;
  refundedAmountMinorUnits: number | null;
  platformFeeMinorUnits: number | null;
}
