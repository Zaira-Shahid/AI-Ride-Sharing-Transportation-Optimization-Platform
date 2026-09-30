// Phase 14 (Security audit, module "App Check"). See index.ts's own header comment on
// setGlobalOptions for the full reasoning: this must stay off (the default) until BOTH a real
// deployment exists AND every client app initializes the App Check SDK with a real provider -
// verified directly against the Functions emulator that turning it on before then answers every
// single callable with a flat 401, since no client anywhere sends an App Check token yet.

/**
 * Whether every onCall function should reject a caller with no valid App Check token. From
 * ENFORCE_APP_CHECK, unset (or anything other than 'true') meaning off - the same
 * unset-means-off convention as OPTIMIZATION_SERVICE_URL/STRIPE_SECRET_KEY.
 */
export function enforceAppCheckFromEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENFORCE_APP_CHECK === 'true';
}
