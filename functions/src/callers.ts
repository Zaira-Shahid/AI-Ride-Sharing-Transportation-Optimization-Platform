import { HttpsError } from 'firebase-functions/v2/https';

/** Who is calling a function, taken from the signed token and never from a document. */
export interface Caller {
  uid: string;
  role: unknown;
  emailVerified: boolean;
}

export type DriverCaller = Caller;
export type PassengerCaller = Caller;

export function requireVerifiedDriver(caller: DriverCaller): void {
  if (caller.role !== 'DRIVER' || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'Only verified drivers can do this.');
  }
}

export function requireVerifiedPassenger(caller: PassengerCaller): void {
  if (caller.role !== 'PASSENGER' || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'Only verified passengers can do this.');
  }
}
