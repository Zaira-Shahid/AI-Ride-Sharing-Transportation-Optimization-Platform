import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { buildHealthResponse } from './health.js';
import { registerUser } from './registration.js';
import { setAvailability as setDriverAvailability } from './availability.js';
import {
  declareDestination as declareDriverDestination,
  setJourneyDetour as setDriverJourneyDetour,
  setJourneyOrigin as setDriverJourneyOrigin,
  setJourneySeats as setDriverJourneySeats,
} from './journeys.js';
import { updateDriverLocation as updateDriverJourneyLocation } from './locations.js';
import {
  cancelTripRequest as cancelPassengerTripRequest,
  createTripRequest as createPassengerTripRequest,
} from './tripRequests.js';
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

export const setJourneyOrigin = onCall((request) =>
  setDriverJourneyOrigin({ firestore: getFirestore() }, callerOf(request), request.data),
);

export const updateDriverLocation = onCall((request) =>
  updateDriverJourneyLocation({ firestore: getFirestore() }, callerOf(request), request.data),
);
