import { HttpsError } from 'firebase-functions/v2/https';

/** Who is calling a function, taken from the signed token and never from a document. */
export interface DriverCaller {
  uid: string;
  role: unknown;
  emailVerified: boolean;
}

export function requireVerifiedDriver(caller: DriverCaller): void {
  if (caller.role !== 'DRIVER' || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'Only verified drivers can do this.');
  }
}
