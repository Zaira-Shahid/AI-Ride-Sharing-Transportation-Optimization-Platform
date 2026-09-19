import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { buildHealthResponse } from './health.js';

setGlobalOptions({ region: 'europe-west1' });

export const healthCheck = onRequest((_request, response) => {
  response.status(200).json(buildHealthResponse());
});
