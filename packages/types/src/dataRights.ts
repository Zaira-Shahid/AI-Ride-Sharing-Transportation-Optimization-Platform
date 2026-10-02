// Phase 14 (Privacy compliance, spec section 56): a passenger or a driver downloading their own data
// and deleting their own account (functions/src/dataRights.ts and driverDataRights.ts have the full
// policy: what is exported, what is removed, what is anonymized and kept, and what is refused).

/** The exact text the app sends to confirm a deletion; the function refuses anything else. */
export const DELETE_ACCOUNT_CONFIRMATION = 'DELETE';

export interface PassengerDataExport {
  exportedAt: string;
  profile: {
    name: string | null;
    email: string | null;
    phone: string | null;
    status: string | null;
    createdAt: string | null;
    hasSavedPaymentMethod: boolean;
  };
  /** At most 500, in no particular order; a place is null once the 30-day retention sweep cleared it. */
  trips: Record<string, unknown>[];
  receipts: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  /** True when a record kind hit its cap and some records were left out. */
  truncated: boolean;
}

/** A driver's own data: what they gave and earned, never a passenger's name, places or payment. */
export interface DriverDataExport {
  exportedAt: string;
  profile: {
    name: string | null;
    email: string | null;
    phone: string | null;
    status: string | null;
    createdAt: string | null;
  };
  driver: {
    verificationStatus: string | null;
    verificationReason: string | null;
    availabilityStatus: string | null;
    rating: number | null;
    totalTrips: number | null;
  } | null;
  vehicle: {
    type: string | null;
    make: string | null;
    model: string | null;
    plateNumber: string | null;
    seatCapacity: number | null;
    verificationStatus: string | null;
  } | null;
  journeys: Record<string, unknown>[];
  earnings: Record<string, unknown>[];
  /** Rides they drove: status, times and fare only. */
  trips: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  truncated: boolean;
}

/** What `exportMyData` returns: the caller's own export, whichever role they have. */
export type PersonalDataExport = PassengerDataExport | DriverDataExport;

export type DeleteMyAccountResult = { status: 'deleted' };
