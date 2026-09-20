# Development guide

## Requirements

- Node.js 22 or newer and npm 10 or newer
- Firebase CLI (`npm i -g firebase-tools`), logged in with `firebase login`
- Java 21 or newer, only for the Firestore emulator

## Commands

| Command                                                | Purpose                                                 |
| ------------------------------------------------------ | ------------------------------------------------------- |
| `npm run verify`                                       | Format check, lint, type check and tests                |
| `npm run lint` / `npm run lint:fix`                    | ESLint                                                  |
| `npm run format` / `npm run format:check`              | Prettier                                                |
| `npm run typecheck`                                    | `tsc --noEmit` in every workspace and at root           |
| `npm test`                                             | Vitest                                                  |
| `npm run dev:admin`                                    | Admin dashboard on port 3000                            |
| `npm run dev:passenger` / `dev:driver`                 | Expo dev servers                                        |
| `npm run build:functions`                              | Compile Cloud Functions to `functions/lib`              |
| `npm run emulators`                                    | Build functions and start Firebase emulators            |
| `npm run verify:firebase`                              | Live check against the real Firebase project            |
| `npm run test:integration`                             | Emulator tests: rules, functions, admin script          |
| `npm run test:e2e`                                     | Playwright: real app UI against the emulators           |
| `npm run web --workspace @ridemesh/passenger`          | Run an app in the browser for development (driver too)  |
| `npm run admin:set-staff-role -- <email> <ROLE>`       | Assign a staff role (see docs/security.md)              |
| `npm run admin:backfill-driver-profiles`               | Create missing driver profiles (see docs/security.md)   |
| `npm run admin:review -- ...`                          | Verify or reject a driver or vehicle (docs/security.md) |
| `npm run export:check --workspace @ridemesh/passenger` | Verify the Android bundle compiles (also driver)        |

## Environment configuration

Each app has a `.env.example` listing the variables it reads. Copy it to a local file and fill in
values from the Firebase console (Project settings, Your apps, Web app config):

- `apps/admin`: copy to `.env.local` (variables prefixed `NEXT_PUBLIC_`)
- `apps/passenger`, `apps/driver`: copy to `.env` (variables prefixed `EXPO_PUBLIC_`)

To develop a mobile app against the local emulators instead of the real project, set
`EXPO_PUBLIC_FIREBASE_EMULATOR_HOST` in its `.env` (`127.0.0.1` for web and iOS simulator,
`10.0.2.2` for an Android emulator, or your computer's LAN address for a physical device) and run
`npm run emulators`. Cloud Functions are not deployed to the real project yet, so registration only
works against the emulators.

`.env` and `.env.*` files are git-ignored; only `.env.example` files are committed. Anything
prefixed `NEXT_PUBLIC_` or `EXPO_PUBLIC_` is shipped to the client, so never put a secret in one.
Privileged credentials such as service account keys, Stripe secret keys and webhook secrets belong
in Firebase secret management on the server side only.

To confirm the local env files work and the app reaches the real project, run
`npm run verify:firebase`. It checks that every app reads a complete config for the pinned project
and that Firestore is reachable and rejects an unauthenticated read (the deny-all rules). It needs
the local env files and network access, so it is not part of `npm run verify` or CI.

`@ridemesh/firebase` validates the values at startup and reports which keys are missing without
printing any values. Build the raw object from literal `process.env.X` references; bundlers only
inline variables referenced literally.

### Google Maps key (place search)

The driver app (destination) and the passenger app (where are you going) search places with Google
Places (New). To try it locally:

1. In the Google Cloud console, for the project you use for Maps (a billing account is required;
   Google gives a monthly free credit), enable **Places API (New)**.
2. Create an API key (APIs & Services, Credentials) and restrict it: under **API restrictions**
   allow only Places API (New), and under **Application restrictions** allow only your apps
   (HTTP referrers for the web builds, the package names `com.ridemesh.driver` and
   `com.ridemesh.passenger` and their SHA-1s for Android, the bundle IDs for iOS). One key can cover
   both apps, or use one key per app.
3. Set a quota and a budget alert for the key.
4. Put it in `apps/driver/.env` and `apps/passenger/.env` as `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=...`.
   Those files are git-ignored. Without it the search says place search is not set up.

The key is bundled into the app, so it is public by design: the restrictions in step 2 are what
protect it. Tests never call Google; Playwright answers the Places requests itself, with a fake key
set in `playwright.config.ts`.

## Git workflow

```text
main       production / stable
develop    integration
feature/*  one branch per module, for example feature/foundation
```

Every module follows the same sequence:

1. Read the specification section and inspect existing code.
2. Create `feature/<module>` from `develop`.
3. Implement only that module. Keep frontend and backend integration real.
4. Run `npm run verify`, fix everything.
5. Verify the UI and any Firebase rules.
6. Update documentation.
7. Commit, push the feature branch, open a pull request using the template.
8. Review, then merge into `develop` and verify the integration.
9. Merge `develop` into `main` only when the work is accepted.

Never develop directly on `main`. A module is not finished while lint, type checks or tests fail,
while temporary mocks remain, or while the working tree is dirty. The full Definition of Done is
specification section 82.

### Commit messages

Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `security:`.
Example: `feat: add passenger trip request flow`.

## Testing

Vitest runs unit tests that live next to their code (`*.test.ts`) and repository-level checks in
`tests/`. The repository tests protect structural rules: package scoping, the pinned Firebase
project, deny-all Firestore rules, no committed env values, and no coding-agent branding in product
source.

**The automated tests use ports of their own, so they can run beside your dev servers and
emulators.** Everything the tests start (the two Expo web servers and the Firebase emulators) listens
on the usual port plus 10000:

| What               | Your own (`npm run emulators`, `expo start`) | The tests |
| ------------------ | -------------------------------------------- | --------- |
| Passenger web app  | 8081                                         | 18081     |
| Driver web app     | 8081 (or the next free one)                  | 18082     |
| Auth emulator      | 9099                                         | 19099     |
| Firestore emulator | 8080                                         | 18080     |
| Functions emulator | 5001                                         | 15001     |
| Emulator UI        | 4000                                         | (none)    |

The emulators for the tests are configured in `firebase.test.json` (a copy of `firebase.json` with
these ports, no UI, and the functions' build folder ignored so that someone else rebuilding the
functions does not reload them in the middle of a run). `npm run test:integration` uses the same
file. The apps under test are built with `EXPO_PUBLIC_FIREBASE_EMULATOR_PORT_OFFSET=10000`, which
Playwright sets; you never set it yourself. The numbers live in `packages/config/src/firebase.ts`
(`TEST_PORT_OFFSET`) and `tests/test-ports.ts`, and `tests/ports.test.ts` fails if the two
emulator files ever share a port.

**The end-to-end tests always start their own Expo servers** and never reuse one that is already
running. If a port is taken (by another test run, say), Playwright stops with "http://localhost:18081
is already used" instead of running against whatever is there. Two test runs at once still clash, as
they should; a dev server or emulators of yours no longer do.

End-to-end tests in `tests/e2e` use Playwright with Chromium (`npx playwright install chromium`
once). `npm run test:e2e` starts the emulators and both Expo web builds with fake demo-project
configuration, so it needs no real credentials, and drives the real registration screens.

### Map tiles (OpenStreetMap)

The passenger's map (`packages/map`) draws OpenStreetMap tiles from `tile.openstreetmap.org`. No
key or account is needed. What to know:

- OpenStreetMap's tile server is run on donations and its usage policy allows only light use (no
  bulk downloading, an identifiable referrer or user agent, attribution). That is fine for
  development and a small pilot. **Before launch, switch to a tile provider whose terms cover the
  expected traffic** (Google's, once billing is set up, or a paid or free-tier provider): change
  `packages/map/src/tiles.ts` and the two `MapView` files.
- Tests never call OpenStreetMap; Playwright answers the tile requests itself with a one-pixel image.
- **Not verified on a phone.** The web map was checked in the browser (with real tiles too), but the
  phone map (react-native-maps with `UrlTile`, `mapType="none"` on Android) and expo-location
  have been type-checked and bundled for Android (`npx expo export --platform android` in each app), but not run on a device or emulator. Two things to check when
  one is available: (1) whether Android's Google Maps SDK insists on an API key in the build config
  even with the base map turned off (if it does, use a MapLibre-based map with an OpenStreetMap
  raster style instead of react-native-maps, keeping the same `MapView` props), and (2) that the
  tiles replace Apple's map on iOS. Expo Go may not include every native module.

### The "stuck on Loading" start-up failure (fixed)

Until this was fixed a few percent of Playwright tests (about 4 in 120 start-ups, on either app, always
passing when rerun alone) failed at `getByRole('heading', { name: 'RideMesh Driver' })` with the
page sitting on the loading spinner. The cause was not the app's own code or the emulators:

- The web build created Firebase Auth with `getAuth`, which includes the popup and redirect sign-in
  support. On mobile browsers and Safari (Playwright's `Pixel 7` profile is one) Auth then loads
  Google's script `https://apis.google.com/js/api.js` and **waits for it before it reports the first
  sign-in state** (`_shouldInitProactively` in `@firebase/auth`). The app shows its spinner until
  that first state arrives, so any slow request to Google (this is the real internet, not an
  emulator) kept the app on the spinner, for up to the SDK's own timeout.
- Evidence: in every captured failure the only request still pending was `apis.google.com/js/api.js`;
  blocking that host reproduces the failure every time.
- Fix: the web build now names its persistence (`indexedDBLocalPersistence`,
  `browserLocalPersistence` in `packages/mobile-auth/src/firebase-client.ts`), which initialises Auth
  without the popup and redirect support. The apps only use email and password, so nothing is lost,
  and no script is loaded from Google at start-up. `tests/e2e/startup.e2e.spec.ts` keeps it fixed:
  it never answers requests to Google's hosts and expects the first screen anyway, and that no such
  request was made. After the fix the same 120 start-ups passed.
- The same reasoning applies to the admin dashboard when it gets sign-in: initialise Auth with
  `initializeAuth` and a named persistence, not `getAuth`, unless popup sign-in is really needed.

Integration tests live in `tests/integration` and run against the local Auth, Functions and
Firestore emulators (`npm run test:integration`, needs Java 21). They use the real rules file, the
real functions and the real admin script. Playwright end-to-end tests are added with the modules
that introduce the UI they cover.

Cloud Functions are tested on the emulators only. The project is on the Spark plan, which cannot
deploy functions, so nothing is deployed until the plan is upgraded.

## Continuous integration

`.github/workflows/ci.yml` runs format check, lint, type check, unit tests and the emulator
integration tests, and a second job runs the Playwright end-to-end tests, on pull requests and on
pushes to `develop` and `main`.
