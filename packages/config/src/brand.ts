export const PRODUCT_NAME = 'RideMesh';
export const NPM_SCOPE = '@ridemesh';

export const APP_DISPLAY_NAMES = {
  passenger: PRODUCT_NAME,
  driver: `${PRODUCT_NAME} Driver`,
  admin: `${PRODUCT_NAME} Operations`,
} as const;

export type AppKey = keyof typeof APP_DISPLAY_NAMES;
