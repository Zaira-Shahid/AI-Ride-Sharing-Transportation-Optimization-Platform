import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { buildHealthResponse } from './health.js';
import { registerUser } from './registration.js';
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
