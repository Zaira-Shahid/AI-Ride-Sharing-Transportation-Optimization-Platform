import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { logger, setGlobalOptions } from 'firebase-functions/v2';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { estimateTripRequest } from './estimates.js';
import { buildHealthResponse } from './health.js';
import { matchTripRequest } from './matching.js';
import { optimizationServiceUrlFromEnvironment } from './optimizationClient.js';
import { runBatchOptimization } from './optimizationRun.js';
import { runImmediateOptimizationIfDue } from './optimizationTrigger.js';
import { registerUser } from './registration.js';
import { setAvailability as setDriverAvailability } from './availability.js';
import {
  declareDestination as declareDriverDestination,
  setJourneyDetour as setDriverJourneyDetour,
  setJourneyOrigin as setDriverJourneyOrigin,
  setJourneySeats as setDriverJourneySeats,
} from './journeys.js';
import { nominatimFromEnvironment, reverseGeocode as reverseGeocodePosition } from './geocoding.js';
import { updateDriverLocation as updateDriverJourneyLocation } from './locations.js';
import { calculateRoute as calculateRoadRoute, osrmFromEnvironment } from './routing.js';
import {
  cancelTripRequest as cancelPassengerTripRequest,
  createTripRequest as createPassengerTripRequest,
} from './tripRequests.js';
import {
  approachDropoff as driverApproachDropoff,
  completeDropoff as driverCompleteDropoff,
  confirmPickup as driverConfirmPickup,
  headToPickup as driverHeadToPickup,
  startTransit as driverStartTransit,
} from './tripExecution.js';
import { requestReview as requestDriverReview, reviewAsStaff } from './verification.js';
import {
  saveVehicle as saveDriverVehicle,
  setVehicleCapacity as setDriverVehicleCapacity,
} from './vehicles.js';

initializeApp();
setGlobalOptions({ region: 'europe-west1' });

export const healthCheck = onRequest((_request, response) => {
  response.status(200).json(buildHealthResponse());
});

export const completeRegistration = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to continue.');
  }
  return registerUser(
    { auth: getAuth(), firestore: getFirestore() },
    request.auth.uid,
    request.data,
  );
});

export const saveVehicle = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to continue.');
  }
  return saveDriverVehicle(
    { firestore: getFirestore() },
    {
      uid: request.auth.uid,
      role: request.auth.token.role,
      emailVerified: request.auth.token.email_verified === true,
    },
    request.data,
  );
});

export const setVehicleCapacity = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to continue.');
  }
  return setDriverVehicleCapacity(
    { firestore: getFirestore() },
    {
      uid: request.auth.uid,
      role: request.auth.token.role,
      emailVerified: request.auth.token.email_verified === true,
    },
    request.data,
  );
});

function callerOf(request: {
  auth?: { uid: string; token: { role?: unknown; email_verified?: unknown } };
}) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to continue.');
  }
  return {
    uid: request.auth.uid,
    role: request.auth.token.role,
    emailVerified: request.auth.token.email_verified === true,
  };
}

export const reviewDriver = onCall((request) =>
  reviewAsStaff({ firestore: getFirestore() }, 'DRIVER', callerOf(request), request.data),
);

export const reviewVehicle = onCall((request) =>
  reviewAsStaff({ firestore: getFirestore() }, 'VEHICLE', callerOf(request), request.data),
);

export const requestReview = onCall((request) =>
  requestDriverReview({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const setAvailability = onCall((request) =>
  setDriverAvailability({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const declareDestination = onCall((request) =>
  declareDriverDestination({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const setJourneySeats = onCall((request) =>
  setDriverJourneySeats({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const setJourneyDetour = onCall((request) =>
  setDriverJourneyDetour({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const createTripRequest = onCall((request) =>
  createPassengerTripRequest({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const cancelTripRequest = onCall((request) =>
  cancelPassengerTripRequest({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const headToPickup = onCall((request) =>
  driverHeadToPickup({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const confirmPickup = onCall((request) =>
  driverConfirmPickup({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const startTransit = onCall((request) =>
  driverStartTransit({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const approachDropoff = onCall((request) =>
  driverApproachDropoff({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const completeDropoff = onCall((request) =>
  driverCompleteDropoff({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const setJourneyOrigin = onCall((request) =>
  setDriverJourneyOrigin({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const updateDriverLocation = onCall((request) =>
  updateDriverJourneyLocation({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const reverseGeocode = onCall((request) =>
  reverseGeocodePosition(
    { firestore: getFirestore(), provider: nominatimFromEnvironment() },
    callerOf(request),
    request.data,
  ),
);

export const calculateRoute = onCall((request) =>
  calculateRoadRoute(
    { firestore: getFirestore(), provider: osrmFromEnvironment() },
    callerOf(request),
    request.data,
  ),
);

/**
 * Works out the road distance and time of a new trip request (Modules 4.4 and 4.5), just after it is
 * created, so that creating a request never waits for the routing server. It never throws: a request
 * without an estimate is normal (the app says so), and what it logs is the request's ID only, never
 * a place.
 */
export const estimateTripRequestOnCreate = onDocumentCreated(
  { document: 'tripRequests/{tripId}', timeoutSeconds: 60 },
  async (event) => {
    try {
      await estimateTripRequest(
        { firestore: getFirestore(), provider: osrmFromEnvironment() },
        event.params.tripId,
      );
    } catch {
      logger.warn('The estimate for a trip request could not be made.', {
        tripId: event.params.tripId,
      });
    }
  },
);

/**
 * Starts the search for a new trip request (Modules 5.2 and 5.3): moves it from REQUESTED to
 * SEARCHING, running candidate discovery first when it leaves now (stored as candidateCount only).
 * Actual matching no longer happens here - Module 5.5's instant per-request assignment was replaced
 * by the periodic batch optimization run (batchOptimizationRun below) once that was wired up, so a
 * SEARCHING request now waits for the next scheduled run instead of being assigned immediately. Never
 * throws: a request that stays SEARCHING is normal (the trigger can be retried), and nothing about
 * the request's places is logged.
 */
export const matchTripRequestOnCreate = onDocumentCreated(
  { document: 'tripRequests/{tripId}', timeoutSeconds: 120 },
  async (event) => {
    try {
      await matchTripRequest({ firestore: getFirestore() }, event.params.tripId);
    } catch {
      logger.warn('The search for a trip request could not be started.', {
        tripId: event.params.tripId,
      });
    }
  },
);

/**
 * The periodic batch optimization run (Module 6.9/6.10): every 2 minutes, re-optimizes every
 * SEARCHING trip request against every AVAILABLE journey together (real pooling, unlike the old
 * per-request assignment above) and writes any resulting matches straight to Firestore. Does nothing
 * when OPTIMIZATION_SERVICE_URL is not configured (Spark-plan/local environments without the Python
 * service running) - logs and returns rather than failing the invocation. Never throws otherwise: a
 * run that matches nothing is normal, and nothing about requests' or journeys' places is logged.
 */
export const batchOptimizationRun = onSchedule('every 2 minutes', async () => {
  const baseUrl = optimizationServiceUrlFromEnvironment();
  if (!baseUrl) {
    logger.warn('OPTIMIZATION_SERVICE_URL is not set; skipping this batch optimization run.');
    return;
  }
  try {
    const outcome = await runBatchOptimization({
      firestore: getFirestore(),
      provider: osrmFromEnvironment(),
      optimizationService: { baseUrl },
    });
    logger.info('Batch optimization run finished.', outcome);
  } catch {
    logger.warn('The batch optimization run failed.');
  }
});

/**
 * Event-triggered batch optimization (Phase 8, modules 8.1/8.2): a trip request reaching SEARCHING -
 * a brand new request (matchTripRequestOnCreate above), or one released back to it by a driver
 * cancellation (Module 8.5, functions/src/availability.ts) - starts a run right away rather than
 * waiting for the schedule above, which keeps running unchanged as a backstop. Debounced
 * (optimizationTrigger.ts) so a burst of several such requests still shares one run. Does nothing
 * when OPTIMIZATION_SERVICE_URL is not configured, same as the scheduled run; never throws.
 */
export const optimizationRunOnSearching = onDocumentUpdated(
  { document: 'tripRequests/{tripId}', timeoutSeconds: 120 },
  async (event) => {
    const before = event.data?.before.get('status');
    const after = event.data?.after.get('status');
    if (before === after || after !== 'SEARCHING') return;

    const baseUrl = optimizationServiceUrlFromEnvironment();
    if (!baseUrl) return;
    try {
      const outcome = await runImmediateOptimizationIfDue({
        firestore: getFirestore(),
        provider: osrmFromEnvironment(),
        optimizationService: { baseUrl },
      });
      if (outcome) logger.info('Immediate batch optimization run finished.', outcome);
    } catch {
      logger.warn('The immediate batch optimization run failed.');
    }
  },
);
