export type AuthErrorKind =
  | 'validation'
  | 'email-in-use'
  | 'invalid-credential'
  | 'account-disabled'
  | 'role-mismatch'
  | 'invalid-email'
  | 'weak-password'
  | 'network'
  | 'too-many-requests'
  | 'permission'
  | 'role-conflict'
  | 'server'
  | 'unknown';

export interface AuthFailure {
  kind: AuthErrorKind;
  /** Safe to show to a person. Never contains technical details. */
  message: string;
  retryable: boolean;
}

export class AuthFlowError extends Error {
  readonly kind: AuthErrorKind;

  constructor(kind: AuthErrorKind, message: string) {
    super(message);
    this.name = 'AuthFlowError';
    this.kind = kind;
  }
}

const failures: Record<AuthErrorKind, Omit<AuthFailure, 'kind'>> = {
  validation: {
    message: 'Some of your details were not accepted. Please check them and try again.',
    retryable: false,
  },
  'email-in-use': {
    message: 'An account with this email address already exists.',
    retryable: false,
  },
  'invalid-credential': { message: 'Incorrect email or password.', retryable: false },
  'account-disabled': {
    message: 'This account has been disabled. Please contact support.',
    retryable: false,
  },
  'role-mismatch': {
    message: 'This account cannot be used in this app.',
    retryable: false,
  },
  'invalid-email': { message: 'Enter a valid email address.', retryable: false },
  'weak-password': {
    message: 'Choose a stronger password of at least 8 characters.',
    retryable: false,
  },
  network: { message: 'Check your internet connection and try again.', retryable: true },
  'too-many-requests': {
    message: 'Too many attempts. Please wait a moment and try again.',
    retryable: true,
  },
  permission: {
    message: 'You do not have permission to do that. Please sign in again.',
    retryable: false,
  },
  'role-conflict': {
    message: 'This email address is already registered as a different type of account.',
    retryable: false,
  },
  server: { message: 'Something went wrong on our side. Please try again later.', retryable: true },
  unknown: { message: 'Something went wrong. Please try again.', retryable: true },
};

const kindByCode: Record<string, AuthErrorKind> = {
  // Firestore errors carry no prefix.
  'permission-denied': 'permission',
  unavailable: 'network',
  'deadline-exceeded': 'network',
  'auth/email-already-in-use': 'email-in-use',
  'auth/invalid-email': 'invalid-email',
  'auth/invalid-credential': 'invalid-credential',
  'auth/invalid-login-credentials': 'invalid-credential',
  'auth/user-not-found': 'invalid-credential',
  'auth/wrong-password': 'invalid-credential',
  'auth/user-disabled': 'account-disabled',
  'auth/weak-password': 'weak-password',
  'auth/network-request-failed': 'network',
  'auth/too-many-requests': 'too-many-requests',
  'functions/unavailable': 'network',
  'functions/deadline-exceeded': 'network',
  'functions/failed-precondition': 'role-conflict',
  'functions/invalid-argument': 'validation',
  'functions/permission-denied': 'permission',
  'functions/unauthenticated': 'permission',
  'functions/internal': 'server',
  'functions/not-found': 'server',
  'functions/unknown': 'server',
};

export function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code: unknown };
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function describeAuthError(error: unknown): AuthFailure {
  const kind =
    error instanceof AuthFlowError
      ? error.kind
      : (kindByCode[getErrorCode(error) ?? ''] ?? 'unknown');
  const base = failures[kind];
  const message = error instanceof AuthFlowError ? error.message : base.message;
  return { kind, message, retryable: base.retryable };
}
