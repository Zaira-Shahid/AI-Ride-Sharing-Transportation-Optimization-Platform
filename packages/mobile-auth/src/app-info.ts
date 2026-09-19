import { APP_DISPLAY_NAMES } from '@ridemesh/config';
import type { SelfServiceRole } from '@ridemesh/types';
import type { ThemeColors } from '@ridemesh/ui';

export type MobileApp = 'passenger' | 'driver';

export interface AuthScreenProps {
  app: MobileApp;
  theme: ThemeColors;
}

export const ROLE_BY_APP: Record<MobileApp, SelfServiceRole> = {
  passenger: 'PASSENGER',
  driver: 'DRIVER',
};

export function appName(app: MobileApp) {
  return APP_DISPLAY_NAMES[app];
}
