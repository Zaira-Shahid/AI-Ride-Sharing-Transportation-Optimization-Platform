export interface HealthResponse {
  status: 'ok';
  service: 'ridemesh-functions';
}

export function buildHealthResponse(): HealthResponse {
  return { status: 'ok', service: 'ridemesh-functions' };
}
