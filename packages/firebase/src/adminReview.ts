import {
  DRIVER_VERIFICATION_STATUSES,
  VEHICLE_VERIFICATION_STATUSES,
  reviewTargetSchema,
  type DriverVerificationStatus,
  type ReviewDecision,
  type ReviewInput,
  type ReviewResult,
  type ReviewTarget,
  type VehicleType,
  type VehicleVerificationStatus,
} from '@ridemesh/types';
import {
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';
import {
  ADMIN_LIST_PAGE_SIZE,
  sliceStatusPage,
  type Page,
  type PageOptions,
  type StatusCursor,
} from './paging';

// Module 11.2 (admin dashboard: driver/vehicle management): the staff side of the review flow Module
// 2.4 already built (functions/src/verification.ts's reviewAsStaff) - only requestReview (the driver's
// own "look at this again" ask) had a client wrapper before this; nothing could actually list drivers
// or submit a review decision from an app. Deliberately no live subscription here (unlike
// subscribeToDriverProfile/subscribeToVehicle, each following one person's own document) - a one-shot
// fetch is enough for a staff work queue that always re-fetches after every decision, and this
// codebase's own "don't build ahead" pattern applies here too (a live-updating queue is a nicer
// version of this, not a different one - add it if staff volume ever makes a manual refresh painful).

export interface DriverReviewRow {
  uid: string;
  name: string;
  email: string;
  driverVerificationStatus: DriverVerificationStatus;
  driverVerificationReason: string | null;
  vehicle: {
    type: VehicleType | null;
    make: string;
    model: string;
    plateNumber: string;
    verificationStatus: VehicleVerificationStatus;
    verificationReason: string | null;
  } | null;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

/**
 * One page of drivers, each with their own vehicle (if they have saved one) - PENDING drivers first (the
 * actionable queue), then rejected, then verified, each group by uid. That is the database's own order
 * (`verificationStatus`, then document id: PENDING, REJECTED, VERIFIED happen to sort that way), so a
 * page is never re-sorted in the browser and the next page continues exactly where this one stopped.
 * Phase 14 (performance): this used to read every driver at once; it reads `pageSize` (50) and gives a
 * cursor for the next. Every driver document is created with its `verificationStatus`, so ordering by it
 * leaves none out. Firestore rules already let any staff role list `drivers`/`vehicles`/`users` in full
 * (isStaff(), unconditional on the document's own fields), so this is a direct client read, not a
 * callable.
 */
export async function listDriversForReview(
  client: Pick<FirebaseClient, 'firestore'>,
  options: PageOptions<StatusCursor> = {},
): Promise<Page<DriverReviewRow, StatusCursor>> {
  const pageSize = options.pageSize ?? ADMIN_LIST_PAGE_SIZE;
  const fetched = (
    await getDocs(
      query(
        collection(client.firestore, 'drivers'),
        orderBy('verificationStatus'),
        orderBy(documentId()),
        ...(options.cursor ? [startAfter(options.cursor.status, options.cursor.id)] : []),
        limit(pageSize + 1),
      ),
    )
  ).docs;
  const { docs: driverDocs, nextCursor } = sliceStatusPage(fetched, pageSize, 'verificationStatus');

  const rows = await Promise.all(
    driverDocs.map(async (driverDoc): Promise<DriverReviewRow> => {
      const uid = driverDoc.id;
      const driverData = driverDoc.data();
      const [userSnap, vehicleSnap] = await Promise.all([
        getDoc(doc(client.firestore, 'users', uid)),
        getDoc(doc(client.firestore, 'vehicles', uid)),
      ]);
      const userData = userSnap.data();
      const vehicleData = vehicleSnap.data();

      return {
        uid,
        name: typeof userData?.name === 'string' ? userData.name : uid,
        email: typeof userData?.email === 'string' ? userData.email : '',
        driverVerificationStatus: isOneOf(
          DRIVER_VERIFICATION_STATUSES,
          driverData.verificationStatus,
        )
          ? driverData.verificationStatus
          : 'PENDING',
        driverVerificationReason:
          typeof driverData.verificationReason === 'string' ? driverData.verificationReason : null,
        vehicle: vehicleSnap.exists()
          ? {
              type:
                typeof vehicleData?.type === 'string' ? (vehicleData.type as VehicleType) : null,
              make: typeof vehicleData?.make === 'string' ? vehicleData.make : '',
              model: typeof vehicleData?.model === 'string' ? vehicleData.model : '',
              plateNumber:
                typeof vehicleData?.plateNumber === 'string' ? vehicleData.plateNumber : '',
              verificationStatus: isOneOf(
                VEHICLE_VERIFICATION_STATUSES,
                vehicleData?.verificationStatus,
              )
                ? vehicleData.verificationStatus
                : 'PENDING',
              verificationReason:
                typeof vehicleData?.verificationReason === 'string'
                  ? vehicleData.verificationReason
                  : null,
            }
          : null,
      };
    }),
  );

  return { rows, nextCursor };
}

export interface VehicleReviewRow {
  driverId: string;
  driverName: string;
  driverEmail: string;
  type: VehicleType | null;
  make: string;
  model: string;
  plateNumber: string;
  seatCapacity: number | null;
  verificationStatus: VehicleVerificationStatus;
  verificationReason: string | null;
}

/**
 * Module 11.6 (admin dashboard: vehicle management, standalone page). One page of SAVED vehicles (a
 * driver with none yet is simply absent - this is a fleet view, not a driver roster), PENDING first
 * (the database's own order, `verificationStatus` then document id, same as the Drivers page), each
 * with its own driver's name/email so staff can find whose it is. Phase 14 (performance): a page of 50
 * with a cursor instead of the whole fleet. Read-only by design: verify/reject stays on the Drivers
 * page (module 11.2) only, so there is exactly one place that writes a verification decision and one
 * audit trail for it - this page's own "Manage" link points back there.
 */
export async function listVehiclesForReview(
  client: Pick<FirebaseClient, 'firestore'>,
  options: PageOptions<StatusCursor> = {},
): Promise<Page<VehicleReviewRow, StatusCursor>> {
  const pageSize = options.pageSize ?? ADMIN_LIST_PAGE_SIZE;
  const fetched = (
    await getDocs(
      query(
        collection(client.firestore, 'vehicles'),
        orderBy('verificationStatus'),
        orderBy(documentId()),
        ...(options.cursor ? [startAfter(options.cursor.status, options.cursor.id)] : []),
        limit(pageSize + 1),
      ),
    )
  ).docs;
  const { docs: vehicleDocs, nextCursor } = sliceStatusPage(
    fetched,
    pageSize,
    'verificationStatus',
  );

  const rows = await Promise.all(
    vehicleDocs.map(async (vehicleDoc): Promise<VehicleReviewRow> => {
      const driverId = vehicleDoc.id;
      const vehicleData = vehicleDoc.data();
      const userData = (await getDoc(doc(client.firestore, 'users', driverId))).data();

      return {
        driverId,
        driverName: typeof userData?.name === 'string' ? userData.name : driverId,
        driverEmail: typeof userData?.email === 'string' ? userData.email : '',
        type: typeof vehicleData.type === 'string' ? (vehicleData.type as VehicleType) : null,
        make: typeof vehicleData.make === 'string' ? vehicleData.make : '',
        model: typeof vehicleData.model === 'string' ? vehicleData.model : '',
        plateNumber: typeof vehicleData.plateNumber === 'string' ? vehicleData.plateNumber : '',
        seatCapacity:
          typeof vehicleData.seatCapacity === 'number' ? vehicleData.seatCapacity : null,
        verificationStatus: isOneOf(VEHICLE_VERIFICATION_STATUSES, vehicleData.verificationStatus)
          ? vehicleData.verificationStatus
          : 'PENDING',
        verificationReason:
          typeof vehicleData.verificationReason === 'string'
            ? vehicleData.verificationReason
            : null,
      };
    }),
  );

  return { rows, nextCursor };
}

/**
 * Records a staff decision on a driver or their vehicle (functions/src/verification.ts's own
 * reviewAsStaff, via the reviewDriver/reviewVehicle callables) - only ADMIN and SUPER_ADMIN are
 * actually allowed (REVIEWER_ROLES, @ridemesh/types), a restriction this function does not repeat: the
 * server refuses anyone else with 'permission-denied', surfaced here as the same clear message every
 * other permission refusal in this codebase already uses.
 */
export async function submitStaffReview(
  client: Pick<FirebaseClient, 'functions'>,
  target: ReviewTarget,
  driverId: string,
  decision: ReviewDecision,
  reason: string | null,
): Promise<ReviewResult['status']> {
  reviewTargetSchema.parse(target);
  const callableName = target === 'DRIVER' ? 'reviewDriver' : 'reviewVehicle';
  try {
    const result = await httpsCallable<ReviewInput, ReviewResult>(
      client.functions,
      callableName,
    )({ driverId, decision, reason });
    return result.data.status;
  } catch (error) {
    if (getErrorCode(error) === 'functions/permission-denied') {
      throw new AuthFlowError('permission', 'You are not allowed to review drivers.');
    }
    throw error;
  }
}
