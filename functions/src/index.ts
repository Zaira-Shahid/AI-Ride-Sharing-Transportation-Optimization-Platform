import { onRequest } from 'firebase-functions/v2/https';
import { buildHealthResponse } from './health.js';

export const healthCheck = onRequest((_request, response) => {
  response.status(200).json(buildHealthResponse());
});
