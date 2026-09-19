import { z } from 'zod';

const required = z.string().trim().min(1);

export const firebaseWebConfigSchema = z.object({
  apiKey: required,
  authDomain: required,
  projectId: required,
  storageBucket: required,
  messagingSenderId: required,
  appId: required,
  measurementId: z.string().trim().min(1).optional(),
});
export type FirebaseWebConfig = z.infer<typeof firebaseWebConfigSchema>;

export class FirebaseConfigError extends Error {
  readonly missingKeys: string[];

  constructor(missingKeys: string[]) {
    super(`Invalid Firebase configuration. Missing or empty: ${missingKeys.join(', ')}`);
    this.name = 'FirebaseConfigError';
    this.missingKeys = missingKeys;
  }
}

/**
 * Validates a Firebase web configuration object.
 *
 * Callers must build `raw` from statically written `process.env.NEXT_PUBLIC_*` /
 * `process.env.EXPO_PUBLIC_*` references, because the bundlers only inline env values
 * that are referenced literally.
 */
export function parseFirebaseWebConfig(raw: Record<keyof FirebaseWebConfig, string | undefined>) {
  const result = firebaseWebConfigSchema.safeParse(raw);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new FirebaseConfigError(keys);
  }
  return result.data;
}
