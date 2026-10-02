// Module 11.5, second pass (admin dashboard: live map markers). See
// functions/src/liveNetwork.ts's own header comment for why every position here is rounded (the
// same ~11m rounding reverseGeocode already uses), never the exact place only the audited
// getTripDetail call provides.

export interface RoundedPoint {
  latitude: number;
  longitude: number;
}

export interface LiveTripPosition {
  tripId: string;
  unmatched: boolean;
  sharedRide: boolean;
  pickup: RoundedPoint | null;
  dropoff: RoundedPoint | null;
}
