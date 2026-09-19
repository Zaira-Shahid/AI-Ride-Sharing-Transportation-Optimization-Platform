import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import type { FirebaseWebConfig } from './config';

export function initializeFirebaseApp(config: FirebaseWebConfig): FirebaseApp {
  return getApps().length > 0 ? getApp() : initializeApp(config);
}
