import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { requireVerifiedDriver, type DriverCaller } from './callers.js';
import { createNotification } from './notifications.js';
import { sendPushToUser } from './pushNotifications.js';
import type { PushProvider } from './pushProvider.js';
import { computeDelayFlag, type DelayFlag } from './trafficDelay.js';

// Functions deploy from this directory alone, so these mirror gps.ts in @ridemesh/types.
// tests/roles-parity.test.ts fails if they diverge.
export const LOCATION_THROTTLE = {
  minIntervalMs: 30_000,
  minDistanceMeters: 50,
  heartbeatIntervalMs: 5 * 60_000,
  maxAccuracyMeters: 100,
  serverMinIntervalMs: 15_000,
} as const;

export const updateDriverLocationInputSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(1_000_000).nullish(),
  })
  .refine((point) => !(point.latitude === 0 && point.longitude === 0));

export type UpdateDriverLocationResult = { status: 'updated' | 'ignored' | 'throttled' };

export function isUsableAccuracy(accuracy: number | null | undefined): boolean {
  if (accuracy === null || accuracy === undefined) return true;
  return (
    Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= LOCATION_THROTTLE.maxAccuracyMeters
  );
}

/**
 * Records where the calling driver is, on their journey, while they are online. The app decides
 * how often to send (adaptive: see shouldSendLocation in @ridemesh/types); the server does not
 * trust that and checks again:
 * - only a verified driver with an ACTIVE account who is ONLINE can write a position (a driver who
 *   is offline has no business sharing one), and only on their own journey;
 * - a reading less accurate than maxAccuracyMeters is ignored, not stored;
 * - a write less than serverMinIntervalMs after the last one is throttled, not stored, whatever the
 *   app does (a buggy or hostile client cannot write every second).
 * Ignored and throttled readings are normal outcomes and come back as such, not as errors. The
 * position is location data of a private person: it is never written to the audit log or logged.
 *
 * Module 7.6 (live map): the same reading is copied onto every one of the journey's own
 * matchedTripRequestIds, so a matched passenger can see it without needing read access to
 * driverJourneys itself (the same one-way snapshot pattern as driverName/vehicle, Module 7.3) - no
 * new Firestore rule. Written to every id in that list regardless of the request's own current status
 * (COMPLETED/CANCELLED ones too): harmless (nobody reads a closed request's location) and avoids an
 * extra read per id just to filter them out.
 *
 * Module 8.6 (traffic delay): every location update is also this system's only chance to notice the
 * driver falling behind the plan's own pace (trafficDelay.ts) - detection only, copied onto the
 * journey and every matched request the same way currentLocation is; an audit log entry is written
 * only when the flag actually changes (not on every throttled update), to keep the log itself
 * meaningful rather than a running commentary.
 *
 * Module 10.5 (driver delayed push): each still-active matched passenger also gets a push, same scope
 * as the in-app notification right below it (module 8.9) - only when the flag newly turns on, never
 * when it clears, and never the driver themself (they already know; it's their own GPS causing it).
 */
export async function updateDriverLocation(
  deps: { firestore: Firestore; push: PushProvider; now?: () => number },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<UpdateDriverLocationResult> {
  requireVerifiedDriver(caller);

  const parsed = updateDriverLocationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The location is not valid.');
  }
  const { latitude, longitude, accuracy } = parsed.data;
  if (!isUsableAccuracy(accuracy)) return { status: 'ignored' };

  const { firestore } = deps;
  const now = (deps.now ?? Date.now)();
  const userRef = firestore.collection('users').doc(caller.uid);
  const driverRef = firestore.collection('drivers').doc(caller.uid);

  const newlyDelayedPassengerIds: string[] = [];
  let extraMinutesForPush = 0;

  const result = await firestore.runTransaction(async (tx): Promise<UpdateDriverLocationResult> => {
    const [user, driver] = await Promise.all([tx.get(userRef), tx.get(driverRef)]);
    if (!user.exists || user.get('status') !== 'ACTIVE' || !driver.exists) {
      throw new HttpsError('failed-precondition', 'This account cannot share a location.');
    }
    if (driver.get('availabilityStatus') !== 'ONLINE') {
      throw new HttpsError('failed-precondition', 'Go online before you share your location.');
    }

    const currentId: unknown = driver.get('currentJourneyId');
    const journeyRef =
      typeof currentId === 'string' && currentId
        ? firestore.collection('driverJourneys').doc(currentId)
        : null;
    const journey = journeyRef ? await tx.get(journeyRef) : undefined;
    if (!journeyRef || !journey?.exists || journey.get('driverId') !== caller.uid) {
      throw new HttpsError('failed-precondition', 'You have no journey to share a location for.');
    }

    const last: unknown = journey.get('currentLocation');
    const lastAt =
      typeof last === 'object' && last !== null && 'updatedAt' in last
        ? (last as { updatedAt: unknown }).updatedAt
        : null;
    if (
      lastAt instanceof Timestamp &&
      now - lastAt.toMillis() < LOCATION_THROTTLE.serverMinIntervalMs
    ) {
      return { status: 'throttled' };
    }

    const location = {
      latitude,
      longitude,
      accuracy: accuracy ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    };

    // Module 8.6 (traffic delay): every read this needs (the matched requests' own statuses, and the
    // plan they currently share) happens here, before any write below - Firestore transactions
    // require every read before the first write.
    const matchedTripRequestIds: unknown = journey.get('matchedTripRequestIds');
    const tripIds = (Array.isArray(matchedTripRequestIds) ? matchedTripRequestIds : []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    const tripRefs = tripIds.map((id) => firestore.collection('tripRequests').doc(id));
    const tripSnaps = await Promise.all(tripRefs.map((ref) => tx.get(ref)));
    const tripStatusById = new Map(
      tripSnaps.map((snap) => [snap.id, snap.get('status') as string | undefined]),
    );

    const assignedPlanId = tripSnaps[0]?.get('assignedPlanId') as string | undefined;
    const planSnap = assignedPlanId
      ? await tx.get(firestore.collection('journeyPlans').doc(assignedPlanId))
      : null;

    let delay: DelayFlag | null = null;
    if (planSnap?.exists) {
      delay = computeDelayFlag(
        {
          stops: planSnap.get('stops'),
          legs: planSnap.get('legs'),
          createdAt: planSnap.get('createdAt'),
        },
        tripStatusById,
        now,
      );
    }
    const wasDelayed = journey.get('delay') != null;

    tx.update(journeyRef, {
      currentLocation: location,
      delay,
      updatedAt: FieldValue.serverTimestamp(),
    });
    for (const tripRef of tripRefs) {
      tx.update(tripRef, {
        driverLocation: location,
        driverDelay: delay,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    if (Boolean(delay) !== wasDelayed) {
      tx.create(firestore.collection('auditLogs').doc(), {
        timestamp: FieldValue.serverTimestamp(),
        actor: caller.uid,
        action: delay ? 'JOURNEY_DELAY_FLAGGED' : 'JOURNEY_DELAY_CLEARED',
        entity: `driverJourneys/${journeyRef.id}`,
        previousState: { delay: wasDelayed ? journey.get('delay') : null },
        newState: { delay },
        reason: delay
          ? `Running ${delay.extraMinutes} minutes behind the plan's own pace`
          : "Back within the plan's own pace",
      });
      // Module 8.9 (notification): only when newly flagged, not when it clears (spec section 40:
      // "actionable and minimal" - a delay is worth a heads-up, a return to normal pace is not), and
      // only a still-active request (a COMPLETED/CANCELLED one lingering in matchedTripRequestIds has
      // nobody left to tell).
      if (delay) {
        extraMinutesForPush = delay.extraMinutes;
        for (const tripSnap of tripSnaps) {
          const status = tripStatusById.get(tripSnap.id);
          if (status === 'COMPLETED' || status === 'CANCELLED') continue;
          const passengerId = tripSnap.get('passengerId');
          if (typeof passengerId !== 'string' || !passengerId) continue;
          createNotification(tx, firestore, {
            recipientId: passengerId,
            type: 'DRIVER_DELAYED',
            message: `Your driver is running about ${delay.extraMinutes} minutes behind schedule.`,
            relatedEntity: `tripRequests/${tripSnap.id}`,
          });
          // Module 10.5 (driver delayed push): same recipient, same wording, sent as a push after
          // this transaction commits (below) - never inside it, a network call.
          newlyDelayedPassengerIds.push(passengerId);
        }
      }
    }
    return { status: 'updated' };
  });

  if (newlyDelayedPassengerIds.length > 0) {
    await Promise.all(
      newlyDelayedPassengerIds.map((passengerId) =>
        sendPushToUser(deps, passengerId, {
          title: 'Driver delayed',
          body: `Your driver is running about ${extraMinutesForPush} minutes behind schedule.`,
        }),
      ),
    );
  }

  return result;
}
