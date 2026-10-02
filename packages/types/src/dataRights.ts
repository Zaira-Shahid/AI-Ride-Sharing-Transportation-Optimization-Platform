// Phase 14 (Privacy compliance, spec section 56): a passenger downloading their own data and deleting
// their own account (functions/src/dataRights.ts has the full policy: what is exported, what is
// removed, what is anonymized and kept, and what is refused).

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

export type DeleteMyAccountResult = { status: 'deleted' };
