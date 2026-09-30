// Module 12 (Analytics). See functions/src/analytics.ts's own comment for the scope and the exact
// formula chosen for each metric - this type mirrors what that function actually returns.

export interface AnalyticsSummary {
  tripsCompleted: number;
  peopleTransported: number;
  vehiclesUsed: number;
  averageOccupancy: number | null;
  vehicleTripsAvoided: number;
  averageDetourMeters: number | null;
  averageDetourSeconds: number | null;
  averageMatchingTimeSeconds: number | null;
  unmatchedRequests: number;
  cancellationRate: number | null;
  paymentSuccessRate: number | null;
  estimatedEmissionsAvoidedKg: number | null;
}
