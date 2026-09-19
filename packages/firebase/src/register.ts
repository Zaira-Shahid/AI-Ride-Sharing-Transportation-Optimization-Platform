import type {
  CompleteRegistrationInput,
  CompleteRegistrationResult,
  RegistrationFormValues,
  SelfServiceRole,
} from '@ridemesh/types';
import { validateRegistration } from '@ridemesh/types';
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

type Client = Pick<FirebaseClient, 'auth' | 'functions'>;

export interface RegisterAccountInput {
  role: SelfServiceRole;
  values: RegistrationFormValues;
}

export interface RegistrationOutcome {
  emailVerified: boolean;
  /** False when the verification email could not be sent; the person can resend it. */
  verificationEmailSent: boolean;
}

async function createOrResumeAccount(client: Client, email: string, password: string) {
  try {
    return (await createUserWithEmailAndPassword(client.auth, email, password)).user;
  } catch (error) {
    if (getErrorCode(error) !== 'auth/email-already-in-use') throw error;
    // The account may be left over from an earlier attempt that did not finish. The correct
    // password proves ownership, so registration can safely resume. The server still refuses to
    // change a role that was already assigned.
    try {
      return (await signInWithEmailAndPassword(client.auth, email, password)).user;
    } catch {
      throw error;
    }
  }
}

async function finishRegistration(client: Client, user: User, input: CompleteRegistrationInput) {
  if (!user.displayName) {
    await updateProfile(user, { displayName: input.name }).catch(() => undefined);
  }

  await httpsCallable<CompleteRegistrationInput, CompleteRegistrationResult>(
    client.functions,
    'completeRegistration',
  )(input);
  await user.getIdToken(true);

  if (user.emailVerified) return { emailVerified: true, verificationEmailSent: false };
  try {
    await sendEmailVerification(user);
    return { emailVerified: false, verificationEmailSent: true };
  } catch {
    return { emailVerified: false, verificationEmailSent: false };
  }
}

/**
 * Creates the account, has the server assign the role, and sends the verification email.
 *
 * If anything fails after the account exists the person is signed out again, so the form can show
 * the error; submitting the same details again resumes where it stopped.
 */
export async function registerAccount(
  client: Client,
  input: RegisterAccountInput,
): Promise<RegistrationOutcome> {
  const validation = validateRegistration(input.values);
  if (!validation.ok) {
    throw new AuthFlowError('validation', 'Please check the highlighted fields.');
  }
  const { name, email, phone, password } = validation.data;

  const user = await createOrResumeAccount(client, email, password);
  try {
    return await finishRegistration(client, user, {
      role: input.role,
      name,
      ...(phone ? { phone } : {}),
    });
  } catch (error) {
    await signOut(client.auth).catch(() => undefined);
    throw error;
  }
}
