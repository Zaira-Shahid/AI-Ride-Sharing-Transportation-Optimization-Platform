import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { logger, setGlobalOptions } from 'firebase-functions/v2';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { enforceAppCheckFromEnvironment } from './appCheck.js';
import { estimateTripRequest } from './estimates.js';
import {
  retryDelayedJourneys,
  retryStaleAuthorizedHolds,
  retryStuckRequestedTrips,
} from './failureRecovery.js';
import {
  clearExpiredJourneyPlaces,
  clearExpiredTripPlaces,
  TRIP_RETENTION_BATCH_SIZE,
  type TripRetentionOutcome,
} from './tripRetention.js';
import { buildHealthResponse } from './health.js';
import { matchTripRequest } from './matching.js';
import { optimizationServiceUrlFromEnvironment } from './optimizationClient.js';
import { runBatchOptimization } from './optimizationRun.js';
import { runImmediateOptimizationIfDue } from './optimizationTrigger.js';
import {
  deleteMyAccount as deletePassengerAccount,
  exportMyData as exportPassengerData,
} from './dataRights.js';
import { deleteDriverAccount, exportDriverData } from './driverDataRights.js';
import { savePaymentMethod as savePassengerPaymentMethod } from './paymentMethods.js';
import { voidStaleAuthorization } from './paymentVoid.js';
import { handleStripeWebhook } from './paymentWebhook.js';
import { createPushProvider, pushConfigFromEnvironment } from './pushProvider.js';
import { savePushToken as savePersonPushToken } from './pushTokens.js';
import { registerUser } from './registration.js';
import { reoptimizeDelayedJourney } from './routeModification.js';
import {
  createStripeProvider,
  stripeConfigFromEnvironment,
  stripeWebhookSecretFromEnvironment,
} from './stripeProvider.js';
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
import {
  getTripDetailForStaff,
  listActiveTripsForStaff,
  listTripHistoryForStaff,
} from './tripMonitoring.js';
import { listAuditLogsForStaff } from './auditLogs.js';
import { getAnalyticsSummaryForStaff } from './analytics.js';
import {
  clearExpiredOpsCounters,
  functionFailedKind,
  getOperationsSummaryForStaff,
  recordOpsEvent,
} from './opsCounters.js';
import { listActiveTripPositionsForStaff } from './liveNetwork.js';
import {
  getMlStatusForStaff,
  predictCancellationForStaff,
  predictEtaForStaff,
} from './mlPredictions.js';
import { listOptimizationRunsForStaff } from './optimizationMonitoring.js';
import {
  getPaymentsSummaryForStaff,
  listPaymentsForStaff,
  refundPaymentAsStaff,
} from './payments.js';
import { listDisputedTripsForStaff, markDisputeReviewedForStaff } from './disputes.js';
import { setUserStatusAsStaff } from './userManagement.js';
import { requestReview as requestDriverReview, reviewAsStaff } from './verification.js';
import {
  saveVehicle as saveDriverVehicle,
  setVehicleCapacity as setDriverVehicleCapacity,
} from './vehicles.js';

initializeApp();
// Phase 14 (Security audit, module "App Check"): a default for every onCall function below (the
// runtime falls back to this whenever a specific one doesn't set its own - confirmed by reading
// firebase-functions' own onCall implementation, not assumed from its types, which omit the field
// from the onRequest-facing HttpsOptions it re-exposes only for CallableOptions). onRequest functions
// (healthCheck, stripeWebhook) never read this option at all, so it cannot affect either of them.
// See appCheck.ts's own header comment for why this must default to off.
setGlobalOptions({ region: 'europe-west1', enforceAppCheck: enforceAppCheckFromEnvironment() });

export const healthCheck = onRequest((_request, response) => {
  response.status(200).json(buildHealthResponse());
});

/**
 * Module 9.9 (webhooks): Stripe posts events here (a dispute is the only one currently acted on - see
 * paymentWebhook.ts's own note on why). `request.rawBody` (Firebase Functions' own raw, unparsed
 * request body) is required for signature verification - never `request.body`, which has already been
 * JSON-parsed and re-serializing it would not match Stripe's own signed bytes. 503 when Stripe/the
 * webhook secret is not configured yet (same "not configured yet" stance as everywhere else in this
 * codebase); 400 for a missing or invalid signature; 200 for anything else, verified or not otherwise
 * actionable - Stripe retries on non-2xx, and an ignored event type is not a failure worth retrying.
 */
export const stripeWebhook = onRequest(async (request, response) => {
  const stripeConfig = stripeConfigFromEnvironment();
  const webhookSecret = stripeWebhookSecretFromEnvironment();
  if (!stripeConfig || !webhookSecret) {
    response.status(503).send('Stripe webhooks are not configured yet.');
    return;
  }

  const signature = request.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    response.status(400).send('Missing signature.');
    return;
  }

  try {
    const outcome = await handleStripeWebhook(
      { firestore: getFirestore(), stripe: createStripeProvider(stripeConfig) },
      request.rawBody,
      signature,
      webhookSecret,
    );
    if (outcome === 'invalid') {
      response.status(400).send('Invalid signature.');
      return;
    }
    response.status(200).send('ok');
  } catch (error) {
    await recordFailure('stripeWebhook');
    logger.error('Stripe webhook handling failed.', error);
    response.status(500).send('Webhook handling failed.');
  }
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
    { firestore: getFirestore(), push: createPushProvider(pushConfigFromEnvironment()) },
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
    { firestore: getFirestore(), push: createPushProvider(pushConfigFromEnvironment()) },
    {
      uid: request.auth.uid,
      role: request.auth.token.role,
      emailVerified: request.auth.token.email_verified === true,
    },
    request.data,
  );
});

/**
 * Counts one caught exception of the named trigger or sweep (opsCounters.ts), for the Operations page.
 * Never throws and never fails the handler it is called from.
 */
const recordFailure = (name: string) => recordOpsEvent(getFirestore(), functionFailedKind(name));

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
  reviewAsStaff(
    { firestore: getFirestore(), push: createPushProvider(pushConfigFromEnvironment()) },
    'DRIVER',
    callerOf(request),
    request.data,
  ),
);

export const reviewVehicle = onCall((request) =>
  reviewAsStaff(
    { firestore: getFirestore(), push: createPushProvider(pushConfigFromEnvironment()) },
    'VEHICLE',
    callerOf(request),
    request.data,
  ),
);

export const requestReview = onCall((request) =>
  requestDriverReview({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const setUserStatus = onCall((request) =>
  setUserStatusAsStaff({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const listActiveTrips = onCall((request) =>
  listActiveTripsForStaff({ firestore: getFirestore() }, callerOf(request)),
);

export const listActiveTripPositions = onCall((request) =>
  listActiveTripPositionsForStaff({ firestore: getFirestore() }, callerOf(request)),
);

export const listTripHistory = onCall((request) =>
  listTripHistoryForStaff({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const getTripDetail = onCall((request) =>
  getTripDetailForStaff({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const listDisputedTrips = onCall((request) =>
  listDisputedTripsForStaff({ firestore: getFirestore() }, callerOf(request)),
);

export const markDisputeReviewed = onCall((request) =>
  markDisputeReviewedForStaff({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const listAuditLogs = onCall((request) =>
  listAuditLogsForStaff({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const listOptimizationRuns = onCall((request) =>
  listOptimizationRunsForStaff({ firestore: getFirestore() }, callerOf(request)),
);

export const listPayments = onCall((request) =>
  listPaymentsForStaff({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const getPaymentsSummary = onCall((request) =>
  getPaymentsSummaryForStaff({ firestore: getFirestore() }, callerOf(request)),
);

export const getOperationsSummary = onCall((request) =>
  getOperationsSummaryForStaff({ firestore: getFirestore() }, callerOf(request)),
);

export const getAnalyticsSummary = onCall((request) =>
  getAnalyticsSummaryForStaff({ firestore: getFirestore() }, callerOf(request)),
);

// Phase 13 (AI/ML): both prototype models are trained on SYNTHETIC data only, and read only by the
// admin dashboard's own "AI Predictions" page - see mlPredictions.ts's own header comment for the
// hard, non-relaxable boundary. `optimizationService: null` when OPTIMIZATION_SERVICE_URL is unset
// (Spark-plan/local environments without the Python service running) is handled the same way the
// batch optimization runs below already handle it: a clean, typed failure, not a thrown network error.

function optimizationServiceConfigFromEnvironment(): { baseUrl: string } | null {
  const baseUrl = optimizationServiceUrlFromEnvironment();
  return baseUrl ? { baseUrl } : null;
}

export const getMlStatus = onCall((request) =>
  getMlStatusForStaff(
    { optimizationService: optimizationServiceConfigFromEnvironment() },
    callerOf(request),
  ),
);

export const predictEta = onCall((request) =>
  predictEtaForStaff(
    { optimizationService: optimizationServiceConfigFromEnvironment() },
    callerOf(request),
    request.data,
  ),
);

export const predictCancellationRisk = onCall((request) =>
  predictCancellationForStaff(
    { optimizationService: optimizationServiceConfigFromEnvironment() },
    callerOf(request),
    request.data,
  ),
);

export const refundPayment = onCall((request) => {
  const stripeConfig = stripeConfigFromEnvironment();
  if (!stripeConfig) {
    throw new HttpsError('failed-precondition', 'Payments are not available yet.');
  }
  return refundPaymentAsStaff(
    { firestore: getFirestore(), stripe: createStripeProvider(stripeConfig) },
    callerOf(request),
    request.data,
  );
});

export const setAvailability = onCall((request) =>
  setDriverAvailability(
    { firestore: getFirestore(), push: createPushProvider(pushConfigFromEnvironment()) },
    callerOf(request),
    request.data,
  ),
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
  createPassengerTripRequest(
    { firestore: getFirestore(), push: createPushProvider(pushConfigFromEnvironment()) },
    callerOf(request),
    request.data,
  ),
);

export const cancelTripRequest = onCall((request) =>
  cancelPassengerTripRequest(
    { firestore: getFirestore(), push: createPushProvider(pushConfigFromEnvironment()) },
    callerOf(request),
    request.data,
  ),
);

/**
 * Module 9.2 (payment authorization): saves a Stripe payment method reference for the calling
 * passenger. `failed-precondition` when STRIPE_SECRET_KEY is not configured (Spark-plan/local
 * environments, or simply no real Stripe account yet - module 9.1's own scaffolding-only decision) -
 * the same stance batchOptimizationRun takes when OPTIMIZATION_SERVICE_URL is unset, just surfaced as
 * an error here since a caller is actually waiting on an answer, not a schedule quietly skipping a run.
 */
export const savePaymentMethod = onCall((request) => {
  const stripeConfig = stripeConfigFromEnvironment();
  if (!stripeConfig) {
    throw new HttpsError('failed-precondition', 'Payments are not available yet.');
  }
  return savePassengerPaymentMethod(
    { firestore: getFirestore(), stripe: createStripeProvider(stripeConfig) },
    callerOf(request),
    request.data,
  );
});

// Phase 14 (Privacy compliance): a rider's own data export and account deletion - see dataRights.ts
// (passenger) and driverDataRights.ts (driver) for exactly what is exported, removed, anonymized and
// kept. The same two callables serve both: a driver's goes by the caller's signed role, and anyone
// else reaches the passenger's, which refuses everything but a verified passenger. A passenger's
// deletion works without Stripe configured (no card was ever saved then); with a saved customer it
// needs Stripe to reach.
export const exportMyData = onCall((request) => {
  const caller = callerOf(request);
  return caller.role === 'DRIVER'
    ? exportDriverData({ firestore: getFirestore() }, caller)
    : exportPassengerData({ firestore: getFirestore() }, caller);
});

export const deleteMyAccount = onCall((request) => {
  const caller = callerOf(request);
  if (caller.role === 'DRIVER') {
    return deleteDriverAccount(
      { firestore: getFirestore(), auth: getAuth() },
      caller,
      request.data,
    );
  }
  const stripeConfig = stripeConfigFromEnvironment();
  return deletePassengerAccount(
    {
      firestore: getFirestore(),
      auth: getAuth(),
      stripe: stripeConfig ? createStripeProvider(stripeConfig) : undefined,
    },
    caller,
    request.data,
  );
});

export const headToPickup = onCall((request) =>
  driverHeadToPickup(
    { firestore: getFirestore(), push: createPushProvider(pushConfigFromEnvironment()) },
    callerOf(request),
    request.data,
  ),
);

export const confirmPickup = onCall((request) =>
  driverConfirmPickup(
    { firestore: getFirestore(), push: createPushProvider(pushConfigFromEnvironment()) },
    callerOf(request),
    request.data,
  ),
);

export const startTransit = onCall((request) =>
  driverStartTransit(
    { firestore: getFirestore(), push: createPushProvider(pushConfigFromEnvironment()) },
    callerOf(request),
    request.data,
  ),
);

export const approachDropoff = onCall((request) =>
  driverApproachDropoff(
    { firestore: getFirestore(), push: createPushProvider(pushConfigFromEnvironment()) },
    callerOf(request),
    request.data,
  ),
);

/**
 * Module 9.4 (payment capture): stripe is only passed in when configured (Spark-plan/local
 * environments, or simply no real Stripe account yet, leave it undefined) - completeDropoff's own
 * capture attempt is a no-op without it, the same "not configured yet" stance as everywhere else this
 * check appears.
 */
export const completeDropoff = onCall((request) => {
  const stripeConfig = stripeConfigFromEnvironment();
  return driverCompleteDropoff(
    {
      firestore: getFirestore(),
      stripe: stripeConfig ? createStripeProvider(stripeConfig) : undefined,
      push: createPushProvider(pushConfigFromEnvironment()),
    },
    callerOf(request),
    request.data,
  );
});

/** Module 10.2 (push tokens): saves the calling passenger's or driver's own Expo push token. */
export const savePushToken = onCall((request) =>
  savePersonPushToken({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const setJourneyOrigin = onCall((request) =>
  setDriverJourneyOrigin({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const updateDriverLocation = onCall((request) =>
  updateDriverJourneyLocation(
    { firestore: getFirestore(), push: createPushProvider(pushConfigFromEnvironment()) },
    callerOf(request),
    request.data,
  ),
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
  { document: 'tripRequests/{tripId}', timeoutSeconds: 90 },
  async (event) => {
    try {
      await estimateTripRequest(
        { firestore: getFirestore(), provider: osrmFromEnvironment() },
        event.params.tripId,
      );
    } catch (error) {
      await recordFailure('estimateTripRequestOnCreate');
      logger.warn('The estimate for a trip request could not be made.', {
        tripId: event.params.tripId,
        error,
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
 * throws (a caught failure is only logged) - if THIS attempt fails, the request stays REQUESTED, not
 * SEARCHING, with no other trigger watching that status; retryStuckRequestedTripsSweep (Phase 14
 * failure recovery, below) is what actually retries it. Nothing about the request's places is logged.
 */
export const matchTripRequestOnCreate = onDocumentCreated(
  { document: 'tripRequests/{tripId}', timeoutSeconds: 120 },
  async (event) => {
    try {
      await matchTripRequest({ firestore: getFirestore() }, event.params.tripId);
    } catch (error) {
      await recordFailure('matchTripRequestOnCreate');
      logger.warn('The search for a trip request could not be started.', {
        tripId: event.params.tripId,
        error,
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
      push: createPushProvider(pushConfigFromEnvironment()),
    });
    logger.info('Batch optimization run finished.', outcome);
  } catch (error) {
    await recordFailure('batchOptimizationRun');
    logger.warn('The batch optimization run failed.', { error });
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
        push: createPushProvider(pushConfigFromEnvironment()),
      });
      if (outcome) logger.info('Immediate batch optimization run finished.', outcome);
    } catch (error) {
      await recordFailure('optimizationRunOnSearching');
      logger.warn('The immediate batch optimization run failed.', {
        tripId: event.params.tripId,
        error,
      });
    }
  },
);

/**
 * Route modification (Phase 8, module 8.7): reacts to a journey newly being flagged behind its own
 * plan's pace (Module 8.6, functions/src/locations.ts) by asking the optimization service for a
 * fresh stop order from the driver's current position. Fires only on the transition into being
 * delayed (before had no flag, after does) - a driver who stays delayed on later location updates is
 * not re-optimized again and again for no reason; if reoptimizeDelayedJourney succeeds it clears the
 * flag itself, so a later relapse fires this trigger afresh. If THIS one attempt fails, though,
 * nothing else here fires again while the driver stays delayed (before is never null a second time);
 * retryDelayedJourneysSweep (Phase 14 failure recovery, below) is the actual backstop for that case.
 * Does nothing when OPTIMIZATION_SERVICE_URL is not configured, same as the batch runs above; never
 * throws.
 */
export const routeModificationOnDelay = onDocumentUpdated(
  { document: 'driverJourneys/{journeyId}', timeoutSeconds: 120 },
  async (event) => {
    const before = event.data?.before.get('delay');
    const after = event.data?.after.get('delay');
    if (before != null || after == null) return;

    const baseUrl = optimizationServiceUrlFromEnvironment();
    if (!baseUrl) return;
    let planId: string | null = null;
    try {
      const outcome = await reoptimizeDelayedJourney(
        {
          firestore: getFirestore(),
          provider: osrmFromEnvironment(),
          optimizationService: { baseUrl },
          push: createPushProvider(pushConfigFromEnvironment()),
          onPlanWritten: (id) => {
            planId = id;
          },
          onSkip: (reason, detail) =>
            logger.info('Route re-optimization after a traffic delay was skipped.', {
              journeyId: event.params.journeyId,
              reason,
              ...detail,
            }),
        },
        event.params.journeyId,
      );
      logger.info('Route re-optimization after a traffic delay finished.', {
        journeyId: event.params.journeyId,
        planId,
        outcome,
      });
    } catch (error) {
      await recordFailure('routeModificationOnDelay');
      logger.warn('Route re-optimization after a traffic delay failed.', {
        journeyId: event.params.journeyId,
        error,
      });
    }
  },
);

/**
 * Module 9.7 (refunds), first half: voids a stale AUTHORIZED hold the moment a trip that had one moves
 * to SEARCHING or CANCELLED without ever being captured - whichever release path caused it (Module
 * 8.5 driver cancellation, Module 8.7 route modification, or any future one; see paymentVoid.ts's own
 * note on why this lives here rather than in each release path itself). Fires only on the transition
 * INTO a released status while paymentStatus stays AUTHORIZED throughout (a capture racing to CAPTURED
 * around the same time is left alone - nothing to void once it succeeds). Does nothing when Stripe is
 * not configured, same as everywhere else this check appears; never throws.
 */
export const voidStaleAuthorizationOnRelease = onDocumentUpdated(
  'tripRequests/{tripId}',
  async (event) => {
    const before = event.data?.before;
    const after = event.data?.after;
    if (!before || !after) return;
    if (
      before.get('paymentStatus') !== 'AUTHORIZED' ||
      after.get('paymentStatus') !== 'AUTHORIZED'
    ) {
      return;
    }
    const released = new Set(['SEARCHING', 'CANCELLED']);
    if (!released.has(after.get('status')) || released.has(before.get('status'))) return;

    const stripeConfig = stripeConfigFromEnvironment();
    if (!stripeConfig) return;
    try {
      const outcome = await voidStaleAuthorization(
        { firestore: getFirestore(), stripe: createStripeProvider(stripeConfig) },
        event.params.tripId,
      );
      logger.info('Stale payment authorization void attempt finished.', {
        tripId: event.params.tripId,
        outcome,
      });
    } catch (error) {
      await recordFailure('voidStaleAuthorizationOnRelease');
      logger.warn('Failed to void a stale payment authorization.', {
        tripId: event.params.tripId,
        error,
      });
    }
  },
);

// Phase 14 (Failure recovery): three sweeps, each a backstop for exactly one of the one-shot triggers
// above that has no other retry path - see failureRecovery.ts's own header comment for the full
// reasoning behind each. All three reuse the same idempotent function their own real-time trigger
// already calls, so a sweep can never do anything that trigger would not also have done; it only
// gives a failed attempt another chance. Never throw: a sweep that finds nothing to do is normal, and
// nothing about any trip/journey's own places is logged.

export const retryStuckRequestedTripsSweep = onSchedule('every 2 minutes', async () => {
  try {
    const outcome = await retryStuckRequestedTrips({ firestore: getFirestore() });
    if (outcome.checked > 0) logger.info('Stuck REQUESTED trip sweep finished.', outcome);
  } catch (error) {
    await recordFailure('retryStuckRequestedTripsSweep');
    logger.warn('The stuck REQUESTED trip sweep failed.', { error });
  }
});

export const retryDelayedJourneysSweep = onSchedule('every 2 minutes', async () => {
  const baseUrl = optimizationServiceUrlFromEnvironment();
  if (!baseUrl) return;
  try {
    const outcome = await retryDelayedJourneys({
      firestore: getFirestore(),
      provider: osrmFromEnvironment(),
      optimizationService: { baseUrl },
      push: createPushProvider(pushConfigFromEnvironment()),
    });
    if (outcome.checked > 0) logger.info('Delayed journey sweep finished.', outcome);
  } catch (error) {
    await recordFailure('retryDelayedJourneysSweep');
    logger.warn('The delayed journey sweep failed.', { error });
  }
});

export const retryStaleAuthorizedHoldsSweep = onSchedule('every 5 minutes', async () => {
  const stripeConfig = stripeConfigFromEnvironment();
  if (!stripeConfig) return;
  try {
    const outcome = await retryStaleAuthorizedHolds({
      firestore: getFirestore(),
      stripe: createStripeProvider(stripeConfig),
    });
    if (outcome.checked > 0) logger.info('Stale authorized hold sweep finished.', outcome);
  } catch (error) {
    await recordFailure('retryStaleAuthorizedHoldsSweep');
    logger.warn('The stale authorized hold sweep failed.', { error });
  }
});

// Phase 14 (Privacy compliance): once a day, clear the exact places of every trip request, and of
// every driver journey, that ended more than 30 days ago (functions/src/tripRetention.ts has the
// policy and what is kept). A backlog bigger than one batch is worked through in the same run, up to a
// cap, and the rest on the next one. Never throws, and nothing about any record's own places is logged.
async function runRetentionBatches(
  name: string,
  clearBatch: () => Promise<TripRetentionOutcome>,
): Promise<void> {
  try {
    let checked = 0;
    let cleared = 0;
    for (let batch = 0; batch < 10; batch += 1) {
      const outcome = await clearBatch();
      checked += outcome.checked;
      cleared += outcome.cleared;
      if (outcome.checked < TRIP_RETENTION_BATCH_SIZE || outcome.cleared === 0) break;
    }
    if (checked > 0) logger.info(`${name} retention sweep finished.`, { checked, cleared });
  } catch (error) {
    await recordFailure(`${name} retention sweep`);
    logger.warn(`The ${name} retention sweep failed.`, { error });
  }
}

export const clearExpiredTripPlacesSweep = onSchedule('every 24 hours', () =>
  runRetentionBatches('Trip place', () => clearExpiredTripPlaces({ firestore: getFirestore() })),
);

export const clearExpiredJourneyPlacesSweep = onSchedule('every 24 hours', () =>
  runRetentionBatches('Journey place', () =>
    clearExpiredJourneyPlaces({ firestore: getFirestore() }),
  ),
);

// The Operations page's daily failure counters are kept 30 days (opsCounters.ts).
export const clearExpiredOpsCountersSweep = onSchedule('every 24 hours', () =>
  runRetentionBatches('Operations counter', () =>
    clearExpiredOpsCounters({ firestore: getFirestore() }),
  ),
);
