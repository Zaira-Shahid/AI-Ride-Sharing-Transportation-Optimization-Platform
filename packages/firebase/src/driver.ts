import { DRIVER_VERIFICATION_STATUSES, type DriverVerificationStatus } from '@ridemesh/types';
import { doc, onSnapshot } from 'firebase/firestore';
import type { FirebaseClient } from './client';

export interface DriverProfileData {
  verificationStatus: DriverVerificationStatus;
  rating: number | null;
  totalTrips: number;
}

export type DriverProfileSnapshot =
  { status: 'ready'; driver: DriverProfileData } | { status: 'missing' };

function isVerificationStatus(value: unknown): value is DriverVerificationStatus {
  return (DRIVER_VERIFICATION_STATUSES as readonly unknown[]).includes(value);
}

/** Follows drivers/{uid} live. A driver can read but never write this document. */
export function subscribeToDriverProfile(
  client: Pick<FirebaseClient, 'firestore'>,
  uid: string,
  onChange: (snapshot: DriverProfileSnapshot) => void,
  onError: (error: unknown) => void,
): () => void {
  return onSnapshot(
    doc(client.firestore, 'drivers', uid),
    (snapshot) => {
      if (!snapshot.exists()) {
        onChange({ status: 'missing' });
        return;
      }
      const data = snapshot.data();
      onChange({
        status: 'ready',
        driver: {
          // An unrecognised value is treated as the safest state rather than shown as verified.
          verificationStatus: isVerificationStatus(data.verificationStatus)
            ? data.verificationStatus
            : 'PENDING',
          rating: typeof data.rating === 'number' ? data.rating : null,
          totalTrips: typeof data.totalTrips === 'number' ? data.totalTrips : 0,
        },
      });
    },
    onError,
  );
}
