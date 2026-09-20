# Architecture

This document describes the architecture as it exists today, and the constraints from the
specification that later modules must respect. It is updated as each module lands.

## Target architecture (specification section 6)

```text
Passenger app    Driver app    Admin web
       \             |             /
        Firebase Auth + Firestore
                     |
          Firebase Cloud Functions   (orchestration)
                     |
          Optimization service       (Python, FastAPI, OR-Tools on Cloud Run)
                     |
        Maps / routing        ML models
```

Firebase Cloud Functions orchestrate. Heavy optimization runs in a dedicated Python service. AI/ML
is used for prediction; deterministic optimization makes the assignment decisions. An LLM never
controls routing or safety constraints.

## What exists now (through Module 3.2)

| Area            | Location                                  | State                                                                                                                                                                                  |
| --------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passenger app   | `apps/passenger`                          | Welcome, sign-in, registration and email verification, then Home (map and place search), Trips, Wallet, Profile.                                                                       |
| Driver app      | `apps/driver`                             | Same auth flow, then Home (go online), Current Journey, Earnings, History, Profile tabs.                                                                                               |
| Admin dashboard | `apps/admin`                              | Next.js shell with the sidebar sections from spec section 22. Empty states.                                                                                                            |
| Cloud Functions | `functions`                               | `healthCheck`, `completeRegistration`, vehicle, review, `requestReview` and `setAvailability`, `declareDestination`, `setJourneySeats`, `setJourneyDetour` functions. Emulator-tested. |
| Firebase config | `firebase.json`, `.firebaserc`, `*.rules` | Project pinned, emulators configured, role-based rules for `users`, all else closed.                                                                                                   |
| Shared types    | `packages/types`                          | Roles, user and driver profile, state enumerations, `Location`, with Zod schemas.                                                                                                      |
| Design tokens   | `packages/ui`                             | Specification palette, semantic light and dark themes, spacing, radius, type, motion.                                                                                                  |
| Map             | `packages/map`                            | The map and the device location, on OpenStreetMap tiles (Leaflet on the web, react-native-maps on phones). No key needed.                                                              |
| Maps client     | `packages/maps`                           | Google Places (New) place search for drivers and passengers, using plain `fetch`. Routing and geocoding follow in Phase 4.                                                             |
| Firebase client | `packages/firebase`                       | Config validation, client factory, auth and profile flows, `AuthProvider`.                                                                                                             |
| Mobile auth     | `packages/mobile-auth`                    | Shared auth screens (Welcome, Login, Register, Verify, Forgot password, Profile), client.                                                                                              |
| Optimizer       | `services/optimizer`                      | Placeholder only. Built in Phase 6.                                                                                                                                                    |

Nothing here is mocked product logic. No fake data is displayed.

## Package conventions

- npm workspaces. Internal packages are consumed as TypeScript source (`main` points at `src`), so
  there is no build step for them. Next.js uses `transpilePackages`; Metro handles workspace source
  natively.
- All packages are scoped `@ridemesh/*`. The product name and scope live in
  `packages/config/src/brand.ts`.
- `functions` does not import workspace packages. Cloud Functions deploy from the `functions`
  directory alone, so sharing code with it needs a build step. That is decided in the module that
  first needs shared code in a function.
- Strict TypeScript everywhere (`strict`, `noImplicitAny`, `strictNullChecks`, plus
  `noUncheckedIndexedAccess`). `any` is a lint error.

## Mobile authentication flow

Both mobile apps gate their screens on a session status derived from Firebase Auth
(`packages/firebase/src/session.ts`), exposed by `AuthProvider` and `useAuth`:

| Status       | Meaning                                    | Screen shown             |
| ------------ | ------------------------------------------ | ------------------------ |
| `loading`    | First auth state not known yet             | Loading indicator        |
| `signedOut`  | Nobody signed in                           | Welcome, Login, Register |
| `unverified` | Signed in, email not verified              | Verify Email             |
| `incomplete` | Email verified but no server-assigned role | Register (finish set-up) |
| `ready`      | Signed in, verified and has a role         | Tabs                     |

Expo Router `Stack.Protected` groups enforce this in each app's root `_layout.tsx`. Registration
runs inside `runAuthFlow`, which stops the status changing halfway through the multi-step
sequence (create account, assign role, send email). If a step fails after the account exists the
person is signed out so the form can show the error, and submitting the same details again resumes
where it stopped.

The screens live in `packages/mobile-auth` so the passenger and driver apps share them. Each app
passes its own `app` key and theme, which decide the role (`PASSENGER` or `DRIVER`) and the
look.

Sign-in (`signIn` in `packages/firebase/src/sign-in.ts`) refuses an account whose role belongs to
the other app, signs it out again and shows a clear message ("This is a driver account. Please
sign in with the RideMesh Driver app."). Accounts with no role yet, or an unverified email, are let
through so the session gate can guide them. The first screen of the `(auth)` group is pinned with
`unstable_settings` so it does not depend on route ordering.

Password reset starts from a "Forgot password?" link on the Login screen only
(`ForgotPasswordScreen`, `requestPasswordReset` in `packages/firebase/src/password-reset.ts`). It
sends Firebase's standard reset email; the person chooses a new password on Firebase's hosted page,
then returns to the app and signs in. The screen always shows the same message ("If an account
exists for ..., we sent an email"), and "Back to sign in" returns to the existing Login screen
rather than stacking a second one. Custom email templates and a branded reset page are future work.

Signing out is done from the Profile tab (`ProfileScreen`, which also shows who is signed in). It
asks for confirmation with an in-app `ConfirmDialog` rather than `Alert`, because `Alert` does
nothing on web. Confirming ends the session, the status becomes `signedOut` and the protected
routes swap back to the sign-in screens. Cancelling changes nothing.

The Profile screen is also where a person edits their name and phone number. `useProfile`
(`packages/firebase/src/react.tsx`) follows `users/{uid}` live through `subscribeToProfile`, so a
saved change shows up without reloading. `saveProfile` (`packages/firebase/src/profile.ts`)
validates with the shared `validateProfileUpdate` and writes name, phone and `updatedAt` straight
to the person's own document; the Firestore rules allow exactly that write, so no Cloud Function is
involved. An empty phone clears it (stored as `null`). Email is shown but cannot be changed. The
Firebase Auth display name is updated afterwards on a best-effort basis; Firestore stays the source
of truth. A write made while offline never fails by itself, so `saveProfile` gives up after 15
seconds with a "check your connection" message and the person can retry. Driver accounts without a
phone see a hint that one is needed before accepting rides; it is not enforced until driver
onboarding (Phase 2).

Sessions persist across restarts. `createMobileFirebaseClient` (`packages/mobile-auth`) stores the
session in AsyncStorage on phones and uses the browser default on web. Each app keeps its
environment reader in `src/firebase-config.ts` (plain TypeScript, safe to import from Node tests)
and creates its client in `src/firebase.ts` (React Native).

## Driver profile (Phase 2)

`drivers/{uid}` holds what is specific to a driver, separate from the shared `users/{uid}`: the
verification status, availability status, rating, completed trips and the (unused) detour fields. The
document ID is the driver's uid, so a driver has exactly one and rules can check ownership directly.
The fields follow spec section 10.

- **Creation:** `completeRegistration` creates `drivers/{uid}` in the same transaction as
  `users/{uid}` when the role is `DRIVER`, and writes a `DRIVER_PROFILE_CREATED` audit entry. A
  repeated call repairs a driver whose profile is missing. Drivers who registered before this
  module get theirs from `npm run admin:backfill-driver-profiles`.
- **Starting values:** `verificationStatus` `PENDING`, `availabilityStatus` `OFFLINE`, `rating`
  `null`, `totalTrips` 0. `maxDetourMinutes`, `maxDetourDistance` and `automaticMatchingEnabled`
  are `null`; no optimization value is assumed. Module 2.8 put the detour limits on the journey,
  not here, so these two detour fields stay `null` and unused.
- **Reading:** `useDriverProfile` (`packages/firebase/src/react.tsx`) follows the document live.
  The Profile tab shows a read-only "Driver details" card (verification, completed trips, rating) in
  the driver app only, so the passenger app never reads `drivers`. If the document is missing the
  card is replaced by a message and the rest of the screen keeps working; the screen recovers on
  its own once the document exists.
- **Writing:** clients cannot write `drivers/{uid}` at all. Each later Phase 2 module opens only the
  specific fields it owns, and verification changes stay with staff.
- `functions` cannot import `@ridemesh/types`, so the starting values are duplicated in
  `functions/src/drivers.ts`; `tests/roles-parity.test.ts` fails if they diverge.
- The verification values (`PENDING`, `VERIFIED`, `REJECTED`) and availability values (`OFFLINE`,
  `ONLINE`) are a starting set that Modules 2.4 and 2.5 may extend.

## Vehicle (Phase 2)

`vehicles/{uid}` holds a driver's vehicle: `driverId`, `type`, `make`, `model`, `plateNumber`,
`seatCapacity`, `availableSeats` and `verificationStatus` (spec section 10), plus a `plateKey` used
for the uniqueness check. A driver has **one** vehicle for now, so its document ID is the driver's
uid, the same convention as `drivers/{uid}`.

- **Saving:** the driver app calls the `saveVehicle` function (`functions/src/vehicles.ts`); a
  client can never write `vehicles` directly. The function requires a verified email and the
  `DRIVER` role claim, an ACTIVE account and an existing driver profile. It validates the input,
  then in one transaction checks the plate and creates or updates the document and writes a
  `VEHICLE_CREATED` or `VEHICLE_UPDATED` audit entry. Saving identical details changes nothing.
- **Types:** `CAR`, `VAN`, `MINIBUS`. The list lives in `packages/types/src/vehicle.ts` and can grow.
- **Plate numbers are unique.** `plateNumber` keeps what the driver typed, tidied (upper case,
  single spaces); `plateKey` is the same without spaces and hyphens, so `ab-12 cd`, `AB12CD` and
  `AB 12-CD` are one plate. The check runs inside the transaction (Firestore transactions lock the
  queried range), so two drivers saving the same plate at once cannot both succeed. Rules cannot
  run this kind of query, which is why saving goes through a function. Only letters, numbers,
  spaces and hyphens are accepted (2 to 12 characters without separators); no country format is
  assumed. Non-Latin plates are not supported yet.
- **Seats are not set by `saveVehicle`.** `seatCapacity` and `availableSeats` start as `null`, and
  editing the vehicle details keeps whatever they hold. Capacity is set by its own function (below).
  The vehicle's `availableSeats` is kept as in the spec but stays `null`: the seats a driver offers
  live on the journey (Module 2.7, see "Journey and destination").
- **Capacity (Module 2.3).** `seatCapacity` is the number of seats **for passengers**; the driver's
  own seat is not counted, so a "capacity 4" vehicle carries up to 4 passengers. It must be a whole
  number from 1 to 6, the same for every vehicle type (`SEAT_CAPACITY_MIN` and `SEAT_CAPACITY_MAX`
  in `packages/types/src/vehicle.ts`). The driver sets it with a "Passenger seats" control on the
  vehicle card (radio buttons 1 to 6, so nothing has to be typed), which calls `setVehicleCapacity`
  (`functions/src/vehicles.ts`). Raising the number, or setting it for the first time, sends the
  vehicle back to `PENDING`; lowering it never does, and setting the same number changes nothing.
  If the seats on offer on the driver's journey (`driverJourneys.availableSeats`) would exceed the
  new capacity they are lowered to match, in the same transaction, so seats on offer can never be
  more than the vehicle holds. Each change writes a `VEHICLE_CAPACITY_CHANGED` audit
  entry. A vehicle added before this module shows "Not set yet" until the driver picks a number.
- **Verification:** a new vehicle is `PENDING`. If a driver changes any identifying detail the
  vehicle goes back to `PENDING`, because the review was of the earlier details. How staff decide
  is described under Verification below.
- **App:** the driver's Profile tab shows a "Your vehicle" card with an Add or Edit form
  (`VehicleSection`, `useVehicle`). The passenger app never reads `vehicles`.
- `functions` cannot import `@ridemesh/types`, so the vehicle types, defaults, schema and plate
  rules are duplicated in `functions/src/vehicles.ts`; `tests/roles-parity.test.ts` fails if they
  diverge.

## Verification (Phase 2)

A driver profile and a vehicle each carry their own verification (`verificationStatus`, with
`verificationReason` and `verificationReviewedAt`). They are decided separately: a verified driver
can have a vehicle that is still pending, and the reverse. Statuses are `PENDING` (the start),
`VERIFIED` and `REJECTED`.

- **Who decides:** verified `ADMIN` and `SUPER_ADMIN` staff, through the `reviewDriver` and
  `reviewVehicle` functions (`functions/src/verification.ts`). The admin dashboard that will call
  them is Phase 11; until then `npm run admin:review` (service account) makes the same decision by
  the driver's email. Nothing in the apps lets a person verify anyone, themselves included.
- **What a decision carries:** `VERIFIED`, or `REJECTED` with a reason of 1 to 500 characters that
  the driver sees. Staff can change their mind either way (reject a verified driver, verify a
  rejected one). Repeating the same decision changes nothing. Each decision writes an audit entry
  (`DRIVER_VERIFICATION_REVIEWED` or `VEHICLE_VERIFICATION_REVIEWED`) with the staff uid as actor.
- **Asking again:** a rejected driver or vehicle shows the reason and a "Request driver review" or
  "Request vehicle review" button. It calls `requestReview`, which moves only a `REJECTED` record
  back to `PENDING` and clears the reason (kept in the audit trail as `DRIVER_REVIEW_REQUESTED` or
  `VEHICLE_REVIEW_REQUESTED`). On a pending or verified record it does nothing. Changing the vehicle
  details, or raising its seats, also starts a new review and clears the old decision.
- **What is collected:** nothing beyond the status. No identity documents, licence numbers or
  photos are collected or stored in the app; the identity check itself happens outside it. Adding
  documents would need Firebase Storage, retention rules and a privacy review, and is left for a
  later module.
- **What it gates:** going online (see Availability below) needs a `VERIFIED` driver and vehicle
  with seats set, and losing verification takes the driver offline. Creating journeys and matching
  will check it in the modules that own them.
- **App:** the "Driver details" and "Your vehicle" cards show the status through the shared
  `ReviewStatus` component. The passenger app shows none of it.
- The reviewer roles, decisions, reason limit and schemas are duplicated in
  `functions/src/verification.ts`; `tests/roles-parity.test.ts` keeps them aligned.

## Availability (Phase 2)

A driver is `ONLINE` or `OFFLINE` (`availabilityStatus` on `drivers/{uid}`, with
`availabilityChangedAt`). New drivers are `OFFLINE`. It is the driver's own switch, on the Home
tab, but it is changed only by the `setAvailability` function (`functions/src/availability.ts`);
the client cannot write it.

- **Going online needs all of these** (`evaluateGoOnline`): an ACTIVE account, a `VERIFIED` driver
  profile, a vehicle that has been added and is `VERIFIED`, its passenger seats set
  (`seatCapacity`), a destination declared, and seats on offer chosen on the journey
  (`availableSeats`, at least 1 and at most `seatCapacity`; the two seat requirements are
  `seatsSet` and `seatsOffered`), and both detour limits chosen on the journey (`detourSet`).
  Otherwise the function refuses with `failed-precondition` and lists what is unmet. Going offline
  always works.
- **Losing a requirement takes the driver offline at once.** If staff reject the driver profile or
  the vehicle, the driver changes the vehicle's details, or raises its seats (each sends the
  vehicle back to `PENDING`), the same transaction sets an `ONLINE` driver `OFFLINE` and writes a
  `DRIVER_TAKEN_OFFLINE` audit entry (actor: the staff uid or the driver). Lowering seats, a new
  `VERIFIED` decision and saving identical details leave the driver online. Ordinary toggles are not
  audited; the time of the last change is in `availabilityChangedAt`.
- **Home tab** (`DriverHomeScreen`): "You are offline" or "You are online", a Go online / Go
  offline button, and, while the driver cannot go online, a "Before you can go online" checklist
  showing each requirement as done or what is left to do. The button is disabled until every
  requirement is met. The screen follows the driver profile, vehicle and account live, so a staff
  decision shows up without a reload. The same requirement list exists in `@ridemesh/types`
  (`evaluateGoOnline`, for the checklist) and in the function (which enforces it);
  `tests/roles-parity.test.ts` checks them against every combination.
- **No automatic expiry.** A driver who goes online and closes the app, or loses connection, stays
  `ONLINE` until they go offline or lose a requirement. Expiring stale drivers needs a heartbeat or
  a scheduled function (Blaze plan) and belongs with the location strategy (spec section 72);
  matching must not treat an old `availabilityChangedAt` as proof the driver is still there.
- **Online does not mean matched.** Nothing uses `ONLINE` yet. Destination (2.6) and seats on offer
  (2.7) and the maximum detour (2.8) have added their requirements to the same list.

## Journey and destination (Phase 2)

`driverJourneys/{journeyId}` is the driver's trip plan (spec section 10). A driver has at most one
open journey, found through `drivers/{uid}.currentJourneyId`, so the document ID can be generated
and finished journeys can pile up later without any index. Module 2.6 creates it as a `DRAFT` that
holds the destination; the seats on offer (2.7) and the detour limits (2.8) are set on the same
journey, and its later states (`AVAILABLE`, `ACTIVE`, ...) come with the modules that own them.

- **Declaring a destination:** the driver app calls `declareDestination`
  (`functions/src/journeys.ts`). It needs a verified DRIVER, an ACTIVE account and a vehicle, and
  validates the place (latitude -90 to 90, longitude -180 to 180, an address of 1 to 300
  characters, an optional place ID). The first call creates the journey and points the driver at
  it; later calls replace the destination while the journey is still a `DRAFT`, and do nothing if
  it is the same place. A destination is replaced, never cleared. `vehicleId` is the driver's uid,
  the same as their vehicle. `origin` (the driver's position) and `departureTime` stay `null`: the
  origin comes from GPS in Phase 4, and "departing" means "when the driver goes online".
- **Where the place comes from:** Google Places (New), used from the app through the
  `@ridemesh/maps` package (`packages/maps/src/places.ts`). It sends an autocomplete request as the
  person types (after two characters, 300 ms after they stop, and cancelling requests that were
  overtaken), then one details request for the place they pick, asking only for
  `id,formattedAddress,location`. Both share one session token. The key goes in a request header
  and is never part of a URL or a message. Failures are turned into plain sentences; an
  unreadable answer from Google is rejected rather than trusted. Nothing but plain `fetch` is used.
- **The key:** `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` in the driver app's local `.env` (git-ignored,
  see `docs/development.md`). Without it the Destination card says place search is not set up; it
  never pretends. Expo inlines it into the app, so it is a public key that must be restricted in
  Google Cloud.
- **Home tab:** the driver's Home also has a "Destination" card: the current destination and
  "Change destination", or a search box when none is set (and a note to add a vehicle first when
  there is none). Picking a suggestion saves it straight away. The list of requirements to go
  online now ends with "Destination set" (`destinationDeclared`), so going online needs a
  declared destination, and it can be changed while online. Google requires its attribution next
  to suggestions shown without a map; a "Powered by Google" line is shown, and the official logo
  is still to be added before launch.
- **Reading:** `useJourney` follows the journey document live. The Home screen shows its spinner
  only for the first load, so saving the first destination (which creates a new journey to load)
  does not blank the screen.
- `functions` cannot import `@ridemesh/types`, so the destination schema and the new-journey
  defaults are duplicated in `functions/src/journeys.ts`; `tests/roles-parity.test.ts` keeps them
  aligned.
- **Seats on offer (Module 2.7).** `driverJourneys.availableSeats` is how many passenger seats the
  driver offers on this journey. It starts `null` and the driver has to choose: nothing is filled in
  for them. The driver app's "Seats on offer" card on Home shows radio buttons from 1 up to the
  vehicle's `seatCapacity` and a "Save seats" button, which calls `setJourneySeats`
  (`functions/src/journeys.ts`). The function checks the number is a whole number from 1 to 6
  (`SEAT_CAPACITY_MIN`/`MAX`) and no more than the vehicle's `seatCapacity`, which lives on another
  document and is why this is a function and not a rule. It needs a verified DRIVER with an ACTIVE
  account, a journey (so a destination first) and a vehicle with its seats set, and it changes the
  seats only while the journey is a `DRAFT`, like the destination. Choosing the same number changes
  nothing. Routine changes are not audited. Because journeys stay `DRAFT` until a later module
  moves them on, the seats can still be changed while the driver is online; booked passengers do
  not exist yet, so a later module must decide what changing seats means once there are some.
  `setVehicleCapacity` lowers the journey's seats when the vehicle gets fewer seats (above). The
  card says what is missing when it cannot be used yet (vehicle seats, then a destination).
  `evaluateGoOnline` gained the `seatsOffered` requirement and an `availableSeats` fact; the Home
  checklist shows it as "Choose how many seats you offer below." until it is met. The vehicle's own
  `availableSeats` is not used.
- **Maximum detour (Module 2.8).** `driverJourneys.maxDetourMinutes` and `maxDetourDistance` are how
  far the driver will go out of their way on this journey: extra **minutes** and extra
  **kilometres**, whole numbers, always set together. They live on the journey (a driver may want a
  different limit each trip), not on `drivers/{uid}`. Both start `null` and the driver has to choose
  both: nothing is filled in. The "Maximum detour" card on Home offers presets (5, 10, 15, 20, 30
  min; 1, 2, 5, 10, 15 km) and a "Save detour" button, which calls `setJourneyDetour`
  (`functions/src/journeys.ts`). The function accepts any whole number from 1 to 60 minutes and 1
  to 30 km (`DETOUR_*` in `packages/types/src/journey.ts`, repeated in the function and checked by
  `tests/roles-parity.test.ts`), so the presets can change without a server change. It needs a
  verified DRIVER with an ACTIVE account and a journey (a destination first), and changes the limits
  only while the journey is a `DRAFT`, like the destination and the seats; the same limits can
  therefore still be changed while the driver is online. Saving the same values changes nothing and
  routine changes are not audited. `evaluateGoOnline` gained the `detourSet` requirement (both
  values whole numbers in range) and the two detour facts; the Home checklist shows it as "Choose
  how far you will go out of your way below." until it is met. What the limits mean to matching
  (how a detour is measured, along which route) belongs to the matching modules; nothing uses them
  yet.
- **Not verified against Google itself.** The requests follow Google's documented Places API
  (New) format, and the tests answer them with a stand-in, but no real key has been used yet.
  Check place search once with a real key before relying on it.

## Passenger trip request (Phase 3)

The passenger builds a trip request from a chain of small modules: location search (3.1), map (3.2),
pickup (3.3), destination (3.4), time preferences (3.5), flexibility (3.6), creation (3.7) and
status (3.8).

- **The request is built in the app and submitted once.** Nothing about a request is stored until
  Module 3.7 creates `tripRequests/{id}` with the first status, `REQUESTED` (the spec's trip
  statuses have no `DRAFT`). Until then the pickup, destination, time and flexibility live only in
  the app's memory, so half-finished location data is never on the server and closing the app
  discards it. The place picked in 3.1 is held by `PassengerHomeScreen` for now; the modules after
  it will move it into one shared request state.
- **Location search (Module 3.1).** `PlaceSearch` (`packages/mobile-auth/src/screens/PlaceSearch.tsx`)
  is the one place-search component, used by the passenger's Home and by the driver's Destination
  card. It searches with Google Places autocomplete as the person types (after two characters, 300
  ms after they stop, cancelling overtaken requests), fetches the details of the place they pick
  (id, formatted address and coordinates only) and hands it to the caller as a
  `StoredDestination`. What happens next is the caller's job: the driver saves it through
  `declareDestination`, the passenger keeps it in the app. If the caller throws, the search shows
  why and stays open. Failures are turned into plain sentences and never contain the key. The search
  is not limited to a country. Quick destinations and recent trips from the spec's Home screen are
  not part of 3.1.
- **Passenger Home:** a map that fills the screen, "Where are you going?" with the search on top
  (the place picked is shown as "Heading to" with "Change destination"), and a "Show my location"
  button at the bottom. It sends nothing to the server (checked by an e2e test). Without a Maps key
  the search says place search is not set up; the map does not need one.
- **Map (Module 3.2).** `@ridemesh/map` (`packages/map`) draws the map and finds the device. Its
  parts:
  - `MapView` takes a `destination` and a `currentLocation` (or null) and fills its parent. There is
    one file per platform: `MapView.web.tsx` (Leaflet, bundled with the app; the markers are drawn
    in CSS, so no image files) and `MapView.tsx` (react-native-maps with the tiles drawn over it).
    Both show a destination marker and a "Your location" marker, and frame whatever is on the map
    (`frameMap` in `view.ts`, shared and unit-tested: the whole world when there is nothing, street
    level for one point, the smallest box for two).
  - **The tile provider is one file, `tiles.ts`** (URL template, maximum zoom and the attribution
    text), so moving to Google's tiles or a paid provider later means changing that file and the two
    `MapView` files, nothing that uses the map. Today it is OpenStreetMap's own server: free, no key,
    attribution shown ("© OpenStreetMap contributors"). Its usage policy allows only light use, so
    it suits development and small pilots; switch before launch (see `docs/development.md`).
  - `useCurrentLocation` returns `{ status, point, locate }` (`idle`, `locating`, `ready`,
    `denied`, `unavailable`). The browser's geolocation on the web, expo-location on phones. It asks
    for permission only when the passenger taps "Show my location", takes one reading (nothing is
    watched), and keeps it in memory. Full GPS handling (continuous, background, accuracy) is Phase 4.
  - The map is display only: tapping it does not pick a place (that needs reverse geocoding, Phase 4).
  - `react-native-maps` and `expo-location` are dependencies of both apps, because the shared
    `PassengerHomeScreen` (in `mobile-auth`) imports the map and native modules must be declared by
    the app that builds them; the driver will need a map for navigation in any case. `expo-location`
    is also a config plugin in both `app.json` files with the permission text.

## Design tokens

`packages/ui/src/tokens.ts` is the source of truth. `tokens.css` mirrors the palette and radii for
Tailwind in the admin app, and a unit test fails if the two drift apart. Colours are used
semantically: cyan for accent, emerald for success, amber for warning, red for danger.

The passenger app uses the light theme and the driver app uses the dark theme, which reduces glare
while driving. Each is a one-line change in the app's `src/theme.ts`.

## Firebase

- Project ID: `ai-ride-sharing-system-a6743`, pinned in `.firebaserc`.
- Region: Firestore and Cloud Functions both use `europe-west1` (Belgium). The constant lives in
  `packages/config/src/firebase.ts`; `functions/src/index.ts` sets the same value, and a repository
  test keeps them aligned. A Firestore location cannot be changed after creation.
- `firestore.rules` allows only verified users to read their own profile (staff may read any). A
  person may update only their own name and phone; every other write is denied. A driver may read
  their own `drivers/{uid}` and `vehicles/{uid}` documents; nothing may be written to either from a
  client (vehicles are saved by a function). Roles are
  custom claims set server-side; see `docs/security.md`.
- The client uses long-polling auto-detection for Firestore, which helps on React Native networks
  where streaming is unavailable.
- Emulator ports: Auth 9099, Functions 5001, Firestore 8080, UI 4000. Local function URLs include
  the region: `http://127.0.0.1:5001/<project>/europe-west1/healthCheck`.
- One Firebase web app ("Ride Sharing App") serves the admin, passenger and driver apps. Its
  configuration values are kept in local, git-ignored env files; see `docs/development.md`.
- Each app has its own small env reader (`apps/admin/lib/firebase.ts`,
  `apps/*/src/firebase.ts`) that builds the config from literal `process.env` references, validates
  it and initialises the shared app from `@ridemesh/firebase`.
- Mobile bundle identifiers: `com.ridemesh.passenger`, `com.ridemesh.driver`. `com.ridemesh.admin`
  is recorded in `packages/config` but unused, because the admin dashboard is a web app.

## Constraints carried forward from the specification

- Pricing follows the transportation plan; it never drives matching.
- The optimizer never silently violates a passenger's accepted constraints.
- Optimization weights and commercial rules are configurable, never hard-coded.
- Plans are versioned; accepted routes are never overwritten blindly.
- No raw card data in Firestore. Payment state is server-authoritative.
- GPS is written to Firestore on an adaptive, throttled schedule, never every second.

## Open decisions

These are intentionally not decided yet and need an explicit answer before the module that depends
on them.

| Decision                                                                                                        | Needed by |
| --------------------------------------------------------------------------------------------------------------- | --------- |
| Passenger flexibility profile fields. Spec sections 3 and 10 name them differently (camelCase is the standard). | Phase 3   |
| App store metadata, icons and splash screens                                                                    | Phase 14  |
| Target country, currency and legal requirements (emergency features, privacy)                                   | Phase 1+  |

Resolved: camelCase is the field-name standard across the specification, `placeId` is optional or
null (a raw GPS pin has none), and the Firestore and Functions region is `europe-west1`.
