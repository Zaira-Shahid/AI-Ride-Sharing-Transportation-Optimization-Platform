// Module 12 (Analytics). See functions/src/analytics.ts's own comment for the scope and the exact
// formula chosen for each metric - this type mirrors what that function actually returns.

export interface AnalyticsSummary {
  tripsCompleted: number;
  peopleTransported: number;
  vehiclesUsed: number;
  averageOccupancy: number | null;
  /** Null once the distinct counts are capped (see distinctCountsCapped): a difference made from a lower bound would be wrong. */
  vehicleTripsAvoided: number | null;
  /** True when there are more completed trips than distinctTripCap, so people transported and vehicles used count only the most recent ones (at least that many). */
  distinctCountsCapped: boolean;
  distinctTripCap: number;
  averageDetourMeters: number | null;
  averageDetourSeconds: number | null;
  averageMatchingTimeSeconds: number | null;
  unmatchedRequests: number;
  cancellationRate: number | null;
  paymentSuccessRate: number | null;
  estimatedEmissionsAvoidedKg: number | null;
}
