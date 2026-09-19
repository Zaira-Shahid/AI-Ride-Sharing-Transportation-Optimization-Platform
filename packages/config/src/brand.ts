export const PRODUCT_NAME = 'RideMesh';
export const NPM_SCOPE = '@ridemesh';

export const APP_DISPLAY_NAMES = {
  passenger: PRODUCT_NAME,
  driver: `${PRODUCT_NAME} Driver`,
  admin: `${PRODUCT_NAME} Operations`,
} as const;

// The admin identifier is recorded for completeness; the admin dashboard is a web app and does not
// use a native bundle identifier.
export const BUNDLE_IDENTIFIERS = {
  passenger: 'com.ridemesh.passenger',
  driver: 'com.ridemesh.driver',
  admin: 'com.ridemesh.admin',
} as const;

export type AppKey = keyof typeof APP_DISPLAY_NAMES;
