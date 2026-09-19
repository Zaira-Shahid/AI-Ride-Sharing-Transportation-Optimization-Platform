export const FIREBASE_REGION = 'europe-west1';

// Local emulator ports. They must match the "emulators" section of firebase.json.
export const EMULATOR_PORTS = {
  auth: 9099,
  functions: 5001,
  firestore: 8080,
} as const;
