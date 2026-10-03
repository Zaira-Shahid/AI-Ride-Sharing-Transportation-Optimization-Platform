# Roles, access and security

Status: through Module 2.8 (maximum detour). Module 1.1 defined the role system and Firestore
rules; registration, login, logout, password reset, profile editing, the driver profile and the
vehicle are built on top of it.

## Roles

`PASSENGER`, `DRIVER`, `SUPPORT`, `OPERATIONS`, `ADMIN`, `SUPER_ADMIN` (specification section 26).

- A person chooses `PASSENGER` or `DRIVER` when they register.
- The four staff roles can never be requested from an app. They are assigned only by a script run
  with service-account credentials.
- The role is stored as a Firebase **custom claim**, which only server-side code can set. Rules and
  functions authorize from the claim. The `role` field inside `users/{uid}` is informational and is
  never used for authorization.

## How a role is assigned

```text
App creates the account with email and password (Firebase Auth)
  -> App calls the completeRegistration function with { role, name, phone? }
  -> Function validates the input, then in one transaction creates users/{uid} and an audit entry
  -> Function sets the custom claim
  -> App refreshes its ID token to pick up the claim
```

`completeRegistration` (Cloud Function, `europe-west1`):

- requires a signed-in caller;
- accepts only `PASSENGER` or `DRIVER`; anything else is rejected as invalid, and unknown fields are
  ignored;
- refuses to change a role once one is assigned (`failed-precondition`), so it cannot be used to
  switch roles or escalate;
- is safe to repeat with the same role and repairs a half-finished earlier attempt;
- writes an `auditLogs` entry (`ROLE_ASSIGNED`, actor, previous and new state, reason).

Email verification is required before any data can be read: the rules check the
`email_verified` token claim. Registration itself works before verification so the role is ready
when the person verifies.

## Password reset

- The reset request gives the same answer whether or not an account exists for the address, and no
  email is sent for an unknown address, so it cannot be used to discover registered emails.
- The link, and the page where the new password is chosen, are Firebase's own. Sending again is
  rate-limited on the screen (60 seconds) and by Firebase.
- **Gap (same cause as the registration password rule):** Firebase's hosted reset page enforces
  Firebase's minimum of 6 characters, not the app's 8. Closing it needs Auth password policy
  (Identity Platform, Blaze plan).
- The reset request does not change the requester's current session.

## Passwords and registration

- Passwords must be at least 8 characters (maximum 128) and are never trimmed. This is enforced by
  the shared validation used by both apps and by `registerAccount`.
- **Limitation:** Firebase Authentication itself only enforces its own minimum of 6 characters. A
  caller who bypasses the app and uses Firebase's public sign-up API directly could still create an
  account with a 6 or 7 character password. Enforcing the policy on the server needs Firebase's
  Auth password policy (part of Identity Platform), which requires the Blaze plan. Revisit when the
  project is upgraded.
- Phone number is optional for both roles for now; it becomes required for drivers in the driver
  onboarding module.
- An email that already exists is only "resumed" when the correct password is supplied, so
  registration cannot be used to take over or change someone else's account, and the server refuses
  to change a role that is already assigned.
- Error messages shown to people never contain raw Firebase or technical text.

## Sign-in and sessions

- Sign-in uses Firebase email and password. Wrong password and unknown email produce the same
  message ("Incorrect email or password."), so the form does not reveal which addresses have an
  account.
- Repeated failures are limited by Firebase's built-in temporary lockout. No custom attempt-based
  rule exists yet; that was a deliberate decision for now.
- A disabled account gets its own clear message.
- **Cross-role refusal is a convenience, not access control.** The apps sign a driver account out of
  the passenger app (and the reverse) and explain why. Rules and functions authorize from the
  server-set role claim; they do not rely on which app was used. Staff accounts are refused in both
  apps without naming the role.
- Sessions persist: AsyncStorage on phones, the browser's storage on web. AsyncStorage is not
  encrypted storage; moving the token to the platform keychain is a hardening item for Phase 14.
- Signing out (Profile tab, with confirmation) ends the session on that device and removes the
  stored session. Nothing else is stored locally. It does not revoke the person's sessions on other
  devices; those stay valid until they expire or staff revoke them.
- After a role is changed by the staff script the person's sessions are revoked and they must sign
  in again.

## Profile editing

- A person can change only their own `name` and `phone`, directly in Firestore. The rule checks
  that the changed keys are a subset of `name`, `phone` and `updatedAt`, so adding, changing or
  removing `role`, `email`, `status`, `createdAt` or any other field is denied.
- `updatedAt` must equal the server's clock (`serverTimestamp()`), so a client cannot back-date it.
- The name must be 1 to 100 characters and not blank. The phone is optional; when present it must
  be 7 to 32 characters from digits, `+`, space, `(`, `)`, `.` and `-`. The apps additionally
  require 7 to 15 digits. The rule and `packages/types/src/auth.ts` must be kept in step.
- Only an `ACTIVE` account can edit; a `SUSPENDED` account is read-only.
- Only the owner can edit. Staff roles have read access to profiles and no write access.
- The role claim and the `role` field are unaffected by any profile edit, so this path cannot be
  used to change roles.
- Email cannot be changed from the app. A change of email needs its own re-verification flow and
  is not part of this module.
- The Firebase Auth display name is copied from the saved name on a best-effort basis. It is
  informational only; nothing authorizes from it.
- Profile edits are not written to `auditLogs`; only role and status changes are audited.

## Driver profile

- `drivers/{uid}` is created by the server (`completeRegistration`, or the backfill script below),
  never by a client. The document ID is the driver's uid.
- **Read:** the driver themselves (verified email, and the `DRIVER` role claim), or verified staff
  (any of the four staff roles). A passenger cannot read one, even one keyed by their own uid. The
  `role` field stored inside a document is never used.
- **Write:** nobody from a client, including the driver, so a driver cannot verify themselves, edit
  their rating or trip count, or go online. Staff decide verification through a function (see
  Verification below), not by writing the document. Later Phase 2 modules open only the specific
  fields each one owns.
- A new driver starts `PENDING` and `OFFLINE`, with rating `null`, 0 trips and no verification
  reason; its own detour fields stay `null` and unused (the detour limits live on the journey).
- Creation writes a `DRIVER_PROFILE_CREATED` audit entry.
- Nothing about a driver's verification is enforced elsewhere yet. Access to journeys and matching
  will check it in the modules that own them. Going online (Module 2.5) already requires it.

```bash
npm run admin:backfill-driver-profiles -- --confirm-production
```

- Creates a driver profile for every driver account that does not have one (accounts registered
  before Module 2.1). It leaves existing profiles untouched, so it is safe to repeat, and writes an
  audit entry (`actor: script:backfill-driver-profiles`) for each one it creates.
- Same safety rules as the staff-role script: against the real project it needs
  `GOOGLE_APPLICATION_CREDENTIALS` and the explicit `--confirm-production` flag; without the flag it
  refuses to run unless the Firestore emulator is configured.

## Vehicle

- `vehicles/{uid}` (one per driver) is created and changed only by the `saveVehicle` function,
  never by a client. The function checks, from the signed token and not from any document:
  the `DRIVER` role claim and a verified email. It also requires an ACTIVE account and an existing
  driver profile, so a suspended driver cannot change their vehicle.
- **Read:** the driver themselves (verified email and the `DRIVER` claim) or verified staff. A
  passenger cannot read a vehicle. Showing vehicle details to a matched passenger is a later module.
- **Write:** nobody from a client. Extra fields in a request (`verificationStatus`, `seatCapacity`,
  `driverId`) are ignored, so a driver cannot verify their own vehicle or set seats through it.
- **Unique plate numbers**, compared without case, spaces or hyphens, enforced in a transaction.
  The error tells the person the plate is already registered but not whose it is.
- A change to type, make, model or plate sends the vehicle back to `PENDING`; a save that changes
  nothing writes nothing.
- Every create and change writes an audit entry (`VEHICLE_CREATED`, `VEHICLE_UPDATED`) with the
  previous and new details. The audit log is never readable by clients.
- **Seat capacity** is changed only by the `setVehicleCapacity` function, with the same caller
  checks as `saveVehicle` (verified email, `DRIVER` claim, ACTIVE account, existing vehicle). It
  accepts a whole number from 1 to 6 and ignores every other field in the request. Claiming more
  seats than were reviewed, or setting seats for the first time, sends the vehicle back to
  `PENDING`; claiming fewer never changes the review state (a `REJECTED` vehicle stays rejected).
  It also keeps `availableSeats` from exceeding the capacity. Each change writes a
  `VEHICLE_CAPACITY_CHANGED` audit entry with the previous and new values. Direct client writes to
  `seatCapacity` are denied by the rules.
- The number of seats is the driver's own claim until staff verify the vehicle. Nothing
  compares it to the make and model yet.
- No proof of ownership, registration document or plate lookup exists yet; verification is
  Module 2.4, and it is a status decided by staff, not an automatic check. A plate is only checked
  for shape and uniqueness.

## Verification

- **Only staff decide.** A driver profile or vehicle becomes `VERIFIED` or `REJECTED` only through
  the `reviewDriver` and `reviewVehicle` functions, or the `admin:review` script. The functions
  check the signed token, never a document: the role claim must be `ADMIN` or `SUPER_ADMIN` and
  the email verified. `SUPPORT`, `OPERATIONS`, drivers, passengers and unverified accounts are
  refused, and so is a driver reviewing their own profile. A role written into a document, for
  example `users/{uid}.role`, grants nothing.
- **Clients cannot write** `verificationStatus`, `verificationReason` or `verificationReviewedAt`
  on `drivers` or `vehicles`; the rules deny every client write to both collections.
- **A rejection needs a reason** (1 to 500 characters after trimming), which the driver can read on
  their own record. Reasons are written by staff, so they should never contain another person's
  personal details. An approval stores no reason.
- **Asking again** (`requestReview`) is for drivers only and moves nothing except a `REJECTED`
  record of their own back to `PENDING`. On a pending or verified record it changes nothing, so it
  cannot be used to reach `VERIFIED`, and the request cannot name someone else's record: the target
  is always the caller's uid. It needs an ACTIVE account.
- **Every decision is audited** with the previous and new status and reason: `*_VERIFICATION_REVIEWED`
  (actor: the staff uid, or `script:review-driver`) and `*_REVIEW_REQUESTED` (actor: the driver).
  Audit logs are never readable by clients.
- **The `driverId` in a review** must look like a Firebase uid (letters, digits, `-`, `_`), so a
  crafted value cannot point at another document path.
- **No documents are collected.** The app stores no identity documents, licence numbers or photos;
  verification is only a status. This avoids holding highly sensitive personal data until a
  document flow, storage, retention and a privacy review are designed (spec section 56).
- **Enforced for going online (Module 2.5).** A driver must be `VERIFIED`, with a `VERIFIED`
  vehicle and seats set, to go online, and losing verification takes them offline. Nothing else is
  gated on the status yet; journeys and matching will check it in the modules that own them.
- **The script** verifies or rejects by the driver's email:

```bash
npm run admin:review -- driver <email> VERIFIED --confirm-production
npm run admin:review -- vehicle <email> REJECTED "Reason shown to the driver" --confirm-production
```

It has the same safety rules as the other scripts: against the real project it needs
`GOOGLE_APPLICATION_CREDENTIALS` and `--confirm-production`, and without the flag it refuses to
run unless the Auth and Firestore emulators are configured.

## Availability

- **Only the server changes it.** `availabilityStatus` and `availabilityChangedAt` on `drivers/{uid}`
  are written by the `setAvailability` function (and by the verification and vehicle functions when
  they take a driver offline). The rules deny every client write, so a driver cannot go online by
  writing the document.
- **Who can call it:** a signed-in DRIVER with a verified email (from the token). Passengers, staff
  and unverified drivers are refused. The target is always the caller's own uid; any other ID in the
  request is ignored.
- **Going online is checked on the server, in a transaction,** against the current documents:
  ACTIVE account, `VERIFIED` driver profile, `VERIFIED` vehicle, seats set. A suspended account,
  a pending or rejected driver or vehicle, no vehicle, or no seats is refused. The app's checklist
  is a convenience; it is not what enforces this.
- **Going offline is always allowed,** including for a driver who is suspended or no longer
  verified.
- **A driver who loses a requirement is taken offline in the same transaction** as the change that
  caused it (staff rejection, vehicle detail change, seats raised) and the system writes a
  `DRIVER_TAKEN_OFFLINE` audit entry. Repeating the same state changes nothing.
- **Limitation: no expiry.** An `ONLINE` driver whose app has closed stays `ONLINE`. Automatic
  expiry needs a scheduled function (Blaze plan) or a heartbeat and is left for the location
  and real-time modules. Do not treat `ONLINE` as proof that a driver is reachable.
- Suspending an account is not yet an action anyone can take, so a suspended driver is not taken
  offline automatically; they are only refused when going online. The admin module will need to
  take suspended drivers offline.

## Journeys and destinations

- **A destination is location data,** so it is kept in one place, `driverJourneys/{id}`, which only
  the driver themselves (verified email and the `DRIVER` claim, matched on the journey's
  `driverId`) and verified staff can read. Passengers cannot. It is not copied anywhere else, and
  the audit trail records that a journey was started, never where it goes.
- **Only the server writes it.** The rules deny every client write to `driverJourneys` and to
  `drivers/{uid}.currentJourneyId`; `declareDestination` creates and changes journeys. It uses the
  caller's own uid, needs a verified DRIVER with an ACTIVE account and a vehicle, and ignores every
  other field in the request (status, seats, detour, another driver's ID).
- **The place is the driver's own claim.** The function checks the shape and range of the
  coordinates and the address length, not that they match a real place, because it has no access to
  Google (functions are not deployed on the Spark plan, and a server-side check would need one).
  A driver who sends made-up coordinates only misdirects their own journey. Matching must not treat
  a destination as verified.
- **The destination can change only while the journey is a `DRAFT`,** and only the driver's own
  journey. A journey that has moved past draft, or a pointer to someone else's journey, is refused.
- **Going online needs a destination** that belongs to the driver; someone else's journey, or one
  without a destination, does not count.
- **Seats on offer are checked on the server.** `setJourneySeats` accepts a whole number from 1 to
  6 and refuses more than the vehicle's `seatCapacity`, reading both in one transaction; the
  rules cannot compare two documents, so a client write of `availableSeats` is denied outright. It
  ignores every other field in the request, needs a verified DRIVER with an ACTIVE account and
  changes only the driver's own `DRAFT` journey. Going online counts seats only when they are
  within 1 and the vehicle's capacity, and only on the driver's own journey. Lowering the vehicle's
  seats lowers the journey's in the same transaction, so a journey can never offer more seats than
  the vehicle holds. Seat changes are not audited.
- **The detour limits are checked on the server too.** `setJourneyDetour` accepts whole minutes
  from 1 to 60 and whole kilometres from 1 to 30, both required, on the driver's own `DRAFT`
  journey only; a client write of `maxDetourMinutes` or `maxDetourDistance` is denied by the rules,
  and every other field in the request is ignored. Going online counts the limits only when both
  are in range and on the driver's own journey. The limits are the driver's own claim and are not
  audited; matching must treat them as a constraint the driver set, not as verified data.
- **The Maps key is public.** Expo bundles `EXPO_PUBLIC_*` values into the app, so anyone can read
  it. Treat it as identifying the app, not as a secret: restrict it to the Places API (New) and to
  the driver app (bundle ID / package name / web origin), set a quota and a budget alert in Google
  Cloud, and never reuse it for a server. It is never committed; `.env.example` lists it empty.
  Requests carry it in a header, and no error message shown to a person contains it.
- **Google's attribution** for place suggestions is shown as text; the official logo still has to
  be added before launch.
- The passenger app uses the same key and the same search (Module 3.1); it is restricted in the
  same way. A passenger's picked place is held only in the app and sent to no server until the trip
  request is confirmed (Module 3.7, see "Trip requests").
- **The passenger's location (Module 3.2).** It is location data of a private person, so: it is
  asked for only when the passenger taps "Show my location" (never on start-up), it is one reading
  (nothing is watched), it is held only in the app's memory, and it is sent to no server of ours
  (an e2e test checks that no function is called and that it is gone after a reload). The browser or
  phone shows its own permission prompt, and a refusal is handled with a plain message. Phones use
  the "while using the app" permission only, never background location.
- **A pickup taken from the device's location is still only in the app.** It is one reading, kept
  in memory with the destination, and sent to no server until the trip request is confirmed
  (Module 3.7). From then on the exact coordinates are stored on `tripRequests`; who can read them
  and how long they are kept are described in "Trip requests" below (spec section 56).
- **The map tile provider sees where the map is looking.** Every tile request carries the tile's
  zoom and position, which is roughly the area the passenger is viewing (including around their
  own location), plus their IP address and the app's referrer. That is a disclosure to
  OpenStreetMap's servers and belongs in the privacy notice (spec section 56) along with Google
  Places. The web map's code is bundled with the app; it loads no third-party script.
- Sending a driver's or passenger's typed search text to Google is a disclosure to a third party. It should be
  covered by the privacy notice and consent required by spec section 56 before launch.

## Trip requests

`tripRequests/{id}` (Module 3.7) holds what a passenger asked for: the exact pickup and destination
coordinates and addresses of a private person, when they want to travel and how flexible they are.

- **Only the passenger who made a request can read it.** The rule needs a verified email, the
  `PASSENGER` claim and `request.auth.uid == resource.data.passengerId`. **Staff cannot read it, and
  neither can drivers**: staff access will come through audited functions when a module needs it
  (support and disputes), not through a blanket read rule. The document ID is generated, so
  ownership comes from `passengerId`.
- **Only the server writes it.** The rules deny every client write to `tripRequests` and the
  `currentTripRequestId` pointer on `users/{uid}` (the profile rule allows a person to change only
  their name and phone). `createTripRequest` and `cancelTripRequest` are the only writers. Both
  need a verified `PASSENGER` (from the signed token, never from a document), and `createTripRequest`
  also an ACTIVE account. They use the caller's own uid and ignore every other field of the input
  (status, fare, another passenger's ID).
- **The server believes nothing the app sent.** It checks the shape and range of both places again,
  refuses 0, 0 and a pickup that is the same place as the destination (the same place ID or under
  50 m), checks the times against **its own clock** (leave now is the server's time; a chosen time
  must be 5 minutes to 7 days ahead, an arrival time after the departure) and accepts only
  preferences that are exactly a flexibility level's numbers plus two booleans. These are mirrors of
  the checks in `@ridemesh/types`; `tests/roles-parity.test.ts` fails if they diverge. A refusal
  carries a `details.reason` from `TRIP_REQUEST_REFUSALS` and a message a person can act on.
- **One open request per passenger.** `users/{uid}.currentTripRequestId` points at it and the
  transaction refuses a second while that one is open (`ALREADY_OPEN`). A pointer to a request that
  is gone or has ended is treated as none. A cancelled request is a normal end: the passenger can
  request again at once.
- **Statuses only move along an allowed table (Module 3.8, spec section 73).**
  `TRIP_STATUS_TRANSITIONS` (in `@ridemesh/types`, mirrored in `functions/src/tripRequests.ts`, and
  compared by the parity test) lists where each status may go: for example `REQUESTED` to `SEARCHING`
  or `CANCELLED` only, and nothing leaves `COMPLETED` or `CANCELLED`. Cancel checks it, and the
  matching modules must use it for every move. Rules cannot enforce it, because no client may write
  `tripRequests` at all; the functions that change a status are the only place it is applied.
- **Cancelling.** A passenger can cancel from `REQUESTED` and `SEARCHING` (`PASSENGER_CANCELLABLE_STATUSES`):
  nothing is committed to a driver yet, so it is free. From `MATCHED` onwards it is refused
  (`NOT_CANCELLABLE`) because a cancellation there needs a policy (fees, penalties) that comes with
  payments. A repeat of a cancel that has happened is "unchanged", not an error, so a retry is
  harmless. Somebody else's request, or one that does not exist, is reported as not found and left
  alone. The audit entry records the status it was cancelled from.
- **Listing a passenger's trips.** The Trips tab queries `tripRequests` with
  `where passengerId == own uid`, newest first, at most 50. The read rule accepts a list only when
  the query itself pins `passengerId` to the caller, so a list without the filter, or for another
  ID, is refused; drivers and staff cannot list at all (rules tests cover each). The query uses the
  `passengerId` + `createdAt` index in `firestore.indexes.json`, which must be deployed with the
  rules before the Trips tab works on the real project.
- **A request nobody picks up stays open (known limitation).** Until matching exists, and after it if
  no driver is found, a `REQUESTED` request stays open, and because a passenger has one open request
  at a time it blocks a new one until they cancel it. Expiring it automatically needs a scheduled
  function, so the Blaze plan, like the retention item below; the passenger can always cancel with
  one tap.
- **The audit trail names no place.** Creating and cancelling write `TRIP_REQUEST_CREATED` and
  `TRIP_REQUEST_CANCELLED` entries with the actor, the request's ID and the status change only;
  the functions log nothing about the places. Tests check that no address or coordinate appears in
  the entry.
- **The fare is `null`** until pricing exists. The distance and time are filled in by the server a
  moment after a request is created (see "Trip estimate" below).
- **Retention: 30 days after a request ends (implemented, Phase 14).** A trip request's exact places
  are removed 30 days after it is COMPLETED or CANCELLED (spec section 56). The functions that end a
  request write `endedAt` (`cancelTripRequest`, and `completeDropoff` through `advance`), and a
  scheduled function, `clearExpiredTripPlacesSweep` (daily, `functions/src/tripRetention.ts`), sets
  `origin`, `destination` and `driverLocation` (the matched driver's last exact position, left on the
  request after the trip) to `null` and marks the request `placesCleared`. **The request itself stays**:
  status, fare, payment fields and who are kept, because fares, receipts, refunds and disputes still
  need them (the decision this item left open "with the payments module"). Each clearing writes a
  `TRIP_PLACES_CLEARED` audit entry (actor `system`) naming the request and never a place; a test
  checks that. Consequences to know: the passenger's own Trips tab leaves out a request once its places
  are cleared (there is nothing left to show on its card, so it is dropped like any unreadable one);
  staff trip detail shows the place as removed instead of a made-up `0,0`. **Not retroactive:** a request
  that ended before `endedAt` existed has no end time and is never cleared (`updatedAt` changes on every
  write, so it cannot age a request honestly) - no real passengers existed at that point. **The same
  rule covers a driver's journey** (below). Export and deletion of a person's own data are in "Your own
  data" below. The privacy notice must state the 30 days before real passengers use the app.

- **Driver journeys: the same 30 days (Phase 14).** A driver's journey carries the same `endedAt` and
  `placesCleared`. `endedAt` is written where a journey ends, which is one place: `completeDropoff`
  completing the last matched ride (`COMPLETED`; nothing in the functions sets `CANCELLED` or
  `PAUSED`). A second daily sweep, `clearExpiredJourneyPlacesSweep` (the same
  `functions/src/tripRetention.ts`, one shared routine), sets the journey's `origin`, `destination` and
  `currentLocation` to `null` 30 days after it ended and marks it `placesCleared`, auditing
  `JOURNEY_PLACES_CLEARED` with the journey's id and no place. What stays: the driver (`driverId` and
  `vehicleId` - it is still their own journey, only account deletion unlinks it), the status and the
  matched request ids. **Not retroactive**, like trips. **Not covered:** a journey that never ended, such
  as a `DRAFT` the driver went offline from and kept - it has no `endedAt`, the same as an open trip
  request, and it is replaced when the driver declares a new destination. Route plans hold no places
  (request ids, stop kinds and totals only), so they need no clearing. A new composite index on
  `driverJourneys` (`placesCleared`, `endedAt`) must be deployed with the function.

## Driver location (Module 4.1)

A driver's position is location data of a private person. Two things are stored, both on the driver's
own journey (`driverJourneys/{id}`), so the journey rules apply: only that driver (verified email and
the `DRIVER` claim, matched on `driverId`) and verified staff can read them, passengers cannot, and
no client can write them.

- **The start of the journey (`origin`).** One reading of the device, taken only when the driver
  presses "Use my current location as the start" (never on start-up; a test checks the browser is not
  asked before the press) and saved by `setJourneyOrigin`. It is stored with its coordinates and no
  place ID, and with the address found for it (see "Reverse geocoding" below) or, when none is
  found, "Current location". It needs a verified driver with an ACTIVE account and a journey (so a
  destination first), and can only change while the journey is a DRAFT. It is **required to go
  online** (`originSet`, after `destinationDeclared`). 0, 0 and out-of-range positions are refused.
- **The current position (`currentLocation`).** Written by `updateDriverLocation` **only while the
  driver is ONLINE**: the app follows the device only then (phones use the "while using the app"
  permission, never a background one, so nothing is shared once the app is closed), and the function
  refuses a driver who is offline, unverified, suspended or without a journey of their own. It stores
  the latitude, longitude, accuracy (or null) and the server's time.
- **Sparingly (spec section 72).** The numbers are one set, `LOCATION_THROTTLE` in `@ridemesh/types`
  (mirrored in `functions/src/locations.ts`, compared by the parity test): the app writes at most every
  **30 seconds**, and only after the driver has moved **50 metres**; a driver standing still is written
  every **5 minutes** (a heartbeat); a reading less accurate than **100 metres** is never used. The
  decision is `shouldSendLocation`, unit-tested including a ten-minute drive at 36 km/h that gives 20
  writes, not 600. The server does not trust the app: it refuses to write more often than every
  **15 seconds** (`throttled`) and ignores an inaccurate reading (`ignored`), and both come back as
  normal results, not errors. The app's own rule is looser than that safety net on purpose, so a normal
  app is never refused.
- **Cleared when the driver goes offline.** `setAvailability` to OFFLINE removes `currentLocation` in
  the same transaction, so a stale position never sits on the journey as if it were current.
  **Known limitation:** when the _system_ takes a driver offline (staff reject the driver or vehicle, or
  raising the seats resets the vehicle to pending), the last position stays on the journey until the
  driver next goes offline or online again. It is readable only by the driver and verified staff, and
  passengers cannot read journeys at all yet; clearing it there means touching the journey from those
  transactions, which is left for the module that lets passengers see a driver.
- **The audit trail records no position.** Neither function writes an audit entry, and neither logs
  the coordinates; tests check that no coordinate appears in the driver's audit entries.
- **Retention.** A position is overwritten by the next one and removed on going offline, but the
  journey's `origin` stays with the journey. The retention rule for journeys (like the 30 days for trip
  requests above) is still to be decided with the privacy notice (spec section 56), and automatic
  deletion needs a scheduled function, so the Blaze plan.
- **Passengers' positions are not shared.** A passenger's own device position is still only used on
  demand, in memory, for the pickup or the map (Modules 3.2 and 3.3).

## Reverse geocoding (Module 4.2)

A position from a device gets an address, so the driver's start and a passenger's current-location
pickup can say where they are and not only "Current location". The address comes from **Nominatim
(OpenStreetMap)**, asked by the `reverseGeocode` function, which is a disclosure of a private
person's location to a third party.

- **Only a rounded position leaves the device.** The position is rounded to 4 decimals (about 11 m)
  by the app before it calls our function (`roundForGeocoding`, an end-to-end test checks the request
  body), and again by the function before it is sent to Nominatim or cached (mirrored in
  `functions/src/geocoding.ts` and parity-tested, because the server does not trust the app); the exact
  position stays in our own database, on the trip request or the journey. A test checks what the
  provider actually receives, and that no exact coordinate or user ID reaches the cache. The
  price is an address that is right to the street and often the building, not always the door.
- **Who and what.** Only a verified driver or passenger (from the signed token) can ask; staff cannot,
  and 0, 0 and out-of-range positions are refused. The address is the app's own claim once it is
  passed on (a journey start or a trip place), like a destination from Google.
- **Cached by rounded position alone.** Answers, including "there is no address here", are stored in
  `geocodeCache/{lat}_{lon}` (rounded): the address, the rounded coordinates and a time, nothing
  about who asked. Nominatim's usage policy asks for caching, and it keeps repeat lookups off a
  public server. **Nothing expires the cache yet** (that needs a scheduled function, so the Blaze
  plan): add it to the retention items above and below. A failure is never cached.
- **Limits.** The public server allows at most one request a second, so the function claims a place
  in line in Firestore (`geocodeGlobal/lookups`: at least 1.1 s between lookups from everybody) and
  each caller may cause 10 lookups a minute (`geocodeLimits/{uid}`); a lookup answered from the cache
  costs neither. Over a limit, or if the counters cannot be updated, the answer is `busy`. The
  provider is asked with a 5 s timeout. `GEOCODE_LIMITS` holds the numbers, mirrored and
  parity-tested; the tests turn the spacing off in `functions/.env.demo-ridemesh` so that tests
  running side by side cannot make each other busy, and the limits are tested directly with a
  controlled clock.
- **Never required, never an error.** If the lookup fails, times out, is refused or is busy, the app
  keeps "Current location" and everything else works as before (tests: a failing and a no-address
  position for both apps). The client function returns null and never throws, waits at most 8 s, and
  the provider's failure text is not returned. A lookup that finishes after the passenger has
  chosen another pickup is ignored (an end-to-end test holds the lookup back to prove it).
- **The three collections** (`geocodeCache`, `geocodeLimits`, `geocodeGlobal`) are not in the rules,
  so they are closed to every client (a rules test checks each); only the function reads and writes
  them.
- **Before launch (owner's action).**
  1. Nominatim's policy needs a `User-Agent` that identifies the app **and a way to contact us**. That
     is configuration and not code (`GEOCODING_USER_AGENT`, docs/development.md). It is set to the
     owner's own address, by the owner's decision, in the git-ignored
     `functions/.env.ai-ride-sharing-system-a6743` (the repository is public, so it is never in a
     tracked file). **Replace it with a dedicated support contact when there is one**, and do not
     commit the file. Without it the function sends "RideMesh (contact not configured)", which the
     public server may block.
  2. The public server is for light use only and has no service guarantee. Move to a paid or
     self-hosted Nominatim (or Google) before real traffic: it is one variable (`NOMINATIM_BASE_URL`)
     for another Nominatim, or one new provider for Google, because everything goes through
     `GeocodingProvider`.
  3. The privacy notice (spec section 56) must say that a rounded position is sent to Nominatim
     (OpenStreetMap Foundation infrastructure), and the addresses are OpenStreetMap data
     (© OpenStreetMap contributors, ODbL): show that attribution where they are shown, as the map
     already does for its tiles.
- Calls from the functions emulator to the real Nominatim are possible in development
  (`npm run emulators`, no `.env` for the real project); the deployed function needs the Blaze plan
  for outbound network access, like other external calls.

## Route calculation (Module 4.3)

`calculateRoute` works out the road route through 2 to 10 stops: the distance, the time and the line.
The stops are private locations (a passenger's pickup and destination, a driver's start), and they go
to a third party, **OSRM**, so the rules are those of reverse geocoding (above), and they are tested
the same way.

- **Only rounded stops leave the device.** Every stop is rounded to 4 decimals (about 11 m) by the app
  before it calls our function (`roundStopsForRouting`; a unit test captures what the app sends), and
  again by the function before it is sent to OSRM or cached (mirrored in `functions/src/routing.ts` and
  parity-tested, because the server does not trust the app). The price is a route that starts and
  ends up to about 11 m from where the person is, which is well inside what a road route can tell.
- **Who and what.** Only a verified driver or passenger can ask; staff cannot. 0, 0, out-of-range
  positions, fewer than 2 or more than 10 stops, and any profile but `driving` or `walking` are refused.
- **Walking (Module 4.6) is the same function with a different server.** A `walking` route is asked
  of the foot server and a `driving` one of the car server, each set on its own
  (`ROUTING_BASE_URL_WALKING`, `ROUTING_BASE_URL_DRIVING`). Nothing else differs: the same rounding,
  the same cache (the profile is part of the cache key, so a road route is never the answer to a
  walking question), and the same limits (a walk and a drive count against the same per-person
  and overall budget, tested). It is for matching's walk to a pickup point (Phase 5); nothing shows a
  walking route to anyone yet. **Which server is asked is what makes a route a walking one:** a real
  check found that the community foot server answers the same walking route whatever profile word the
  URL carries (foot, walking or driving), so pointing the walking setting at a car server would return
  driving distances and driving times as if they were a walk, and nothing in the answer would say
  so. The function says "foot" in the URL, the tests' fake refuses a wrong word, and the defaults
  are the community server's separate foot and car servers, but the setting is the owner's to get
  right for any server of their own.
- **Drawing the line (Module 4.7) changes nothing here.** `calculateRoute` has always returned the
  route's line (`geometry`); the passenger map now decodes and draws it (review and the ride
  requested card), but this is a client-side change only - no new call, no new data leaves the
  device, and the line is not stored anywhere (it is asked for again, from the same cache, whenever
  it is needed to draw).
- **A stop that is not near a road is "no route".** OSRM puts a stop on the nearest road however far
  that is: a real check found two points in the middle of the Atlantic came back as an "Ok" route
  that started on a road 594 km away. A stop more than 1,000 m (`ROUTE_LIMITS.maxSnapMeters`) from the
  road OSRM used is answered `none`, so a route never starts somewhere the person is not.
- **Cached by the rounded stops alone.** Routes, including "no route", are stored in
  `routeCache/{hash}` (a SHA-256 of the profile and the rounded stops in order): the profile, the
  rounded stops, the route and a time, nothing about who asked (a test checks this and that no exact
  coordinate is there). Nothing expires the cache yet (a scheduled function needs the Blaze plan): it
  belongs with the other retention items above. A failure is never cached, and a route whose line
  is over 700,000 characters is answered but not stored (a document is at most 1 MiB).
- **Limits.** OSRM's public server is for light use, so the function claims a place in line in
  Firestore (`routeGlobal/lookups`: at least 1.1 s between lookups from everybody) and each caller
  may cause 20 routes a minute (`routeLimits/{uid}`); a route answered from the cache costs neither.
  The counters are separate from geocoding's, because the two servers are separate, and the code is
  shared (`functions/src/lookupLimits.ts`, also used by geocoding, with its tests unchanged). Over a
  limit, or if the counters cannot be updated, the answer is `busy`. The provider gets 8 s. The
  trip estimate does not take a `busy` and retry: it books a slot in line (`reserveLookupSlot`, one
  document per slot in `routeGlobal/lookups/slots`, up to 60 s ahead), which keeps the same 1.1 s
  spacing for everybody but lets a burst of requests be served in turn (docs/load-testing.md); the
  slot documents hold only a number, and old ones are cleared as new ones are booked.
- **Never an error for the person.** Failure, a timeout, a refusal and a busy server are the normal
  results `unavailable` and `busy`, and the client function returns null and never throws. The
  provider's failure text is not returned.
- **The three collections** (`routeCache`, `routeLimits`, `routeGlobal`) are not in the rules, so
  they are closed to every client (a rules test checks each); only the function reads and writes them.
- **The times are not traffic-aware.** OSRM has no traffic data, so the durations are free-flow
  estimates. Everything that shows one says "Estimated without live traffic." (the trip estimate
  below does), and a paid provider with traffic (Google, once billing exists) is the way to change
  that: one new `RoutingProvider`.
- **Before launch (owner's actions).** The routing server is asked with the same contact as
  Nominatim (`ROUTING_USER_AGENT`, else `GEOCODING_USER_AGENT`: docs/development.md). The public
  community server (routing.openstreetmap.de) is for light use only with no guarantee: move to a
  paid or self-hosted OSRM (one variable for each way of travelling, `ROUTING_BASE_URL_DRIVING` and
  `ROUTING_BASE_URL_WALKING`) or Google before real traffic.
  The privacy notice must say that rounded stops go to it too (in the batch with the Nominatim
  and OpenStreetMap items). The deployed function needs the Blaze plan for outbound calls.

## Trip estimate (Modules 4.4 and 4.5)

A trip request carries the road distance (`estimatedDistance`, metres) and time (`estimatedDuration`,
whole seconds) of its route from the pickup to the destination. It is location-derived data of a
private person, and it changes no one's access to anything.

- **Written only by the server, and readable only by the passenger.** The estimate trigger
  (`estimateTripRequestOnCreate`, `functions/src/estimates.ts`) writes the two fields with the Admin SDK
  just after the request is created. The rules are unchanged: only the passenger who made the request
  can read it (staff and drivers cannot), and no client can write it, so the numbers cannot be
  forged (a rules test already refuses a client write to `estimatedFare`, and none of the estimate
  fields is any different).
- **No new disclosure.** The trigger asks for the route as the request's passenger, through the same
  `calculateRoute` as the app: the stops are rounded to about 11 m before they go to OSRM, the route is
  cached by the rounded stops alone, and the same limits apply (counted against that passenger).
  The route the app asked for when it showed the estimate at the review is the same route (same
  rounded stops), so it is normally answered from the cache: one lookup serves both.
- **Never blocks, never fails, never leaks.** It runs after the request exists, so creating a request
  does not wait for the routing server, and the server being down, busy or finding no route leaves
  the estimate empty. It waits and tries again only when the server is busy (up to 4 tries, 1.3 s
  apart). It never throws; what it logs is the request's ID, and nothing about the places.
- **Safe to repeat and to race.** It leaves alone a request that is gone, no longer open (cancelled,
  say, while the route was being found) or that already has an estimate, and writes inside a
  transaction that checks this again (tests race it against a cancellation and against a second
  run, and fail if the check is removed). It changes only the two fields and the time of change.
- **An estimate, not a promise.** It is free-flow (no traffic) and has no detours for sharing, so
  nothing that decides price, matching or whether to accept a request may rely on it without a
  better source. That is why an arrival time that leaves too little for the trip is only a warning
  and never a refusal.
- **Not there when it cannot be.** The app says so after 30 seconds (`ESTIMATE_WAIT_MS`); an old
  request without an estimate is not backfilled.

## Staff roles

```bash
npm run admin:set-staff-role -- <email> <SUPPORT|OPERATIONS|ADMIN|SUPER_ADMIN> --confirm-production
```

- The account must already exist in Firebase Auth. The script replaces any existing role, revokes
  the person's sessions so they must sign in again, creates or updates their profile and writes an
  audit entry (`actor: script:set-staff-role`).
- Against the real project it needs `GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-account
  key file and the explicit `--confirm-production` flag. Without the flag it refuses to run unless
  the Firebase emulators are configured. Never commit a key file.
- It warns if the person's email is not yet verified, because the rules deny unverified accounts.

## Firestore rules (`firestore.rules`)

| Collection          | Read                                                     | Write                                         |
| ------------------- | -------------------------------------------------------- | --------------------------------------------- |
| `users/{uid}`       | Own profile, or any profile for verified staff (4 roles) | Owner may update name and phone only (ACTIVE) |
| `drivers/{uid}`     | That driver, or any driver profile for verified staff    | Nobody                                        |
| `vehicles/{uid}`    | That driver, or any vehicle for verified staff           | Nobody (the saveVehicle function only)        |
| `tripRequests/{id}` | The passenger who made it, and nobody else (not staff)   | Nobody (the trip request functions only)      |
| everything else     | Nobody                                                   | Nobody                                        |

Creating and deleting profiles, and every other write, happens through Cloud Functions or scripts
using the Admin SDK, which bypass rules.
Collections other than `users` stay closed until the module that owns each one defines its rules.
`auditLogs` is never readable by clients. A verified email is required for every allowed read.

### Reading the audit log (staff)

- `auditLogs` still has no rule. Verified `ADMIN` and `SUPER_ADMIN` staff read it through the
  `listAuditLogs` function (module 11.8), newest first, 25 per page, filtered by exact action and/or
  actor (an email, uid, `system` or `script:...`). Other staff roles and everyone else are refused.
- Loading the list writes no audit entry. Nothing is changed or deleted; entries are shown as stored.
- Staff uids are shown with their name and email from `users`; `system` and `script:...` actors are
  shown as stored.
- `VEHICLE_CREATED` and `VEHICLE_UPDATED` entries hold the whole vehicle (plate number included). The
  function returns only the names of the fields that changed for them, never the values, so the plate
  does not leave the server. The stored entries are unchanged.
- Entries name no exact place, and the page does not look one up.

### Reading optimization runs (staff)

- `optimizationRuns` has no rule either. Any verified staff role reads it through the
  `listOptimizationRuns` function (module 11.9) - inspection only, no financial or verification
  decision, the same stance as trip monitoring.
- One document per batch-optimization cycle (Module 8.1's phase 1 only, the one that calls the real
  optimizer; phase 2's simpler insertion heuristic never calls it, so it has no cycle to log). A cycle
  that evaluated 0 open requests or 0 available journeys is not written at all - there is nothing to
  show. Every other cycle is, even one that found no viable candidate or plan.
- **Retention is query-time only.** The function returns the last 500 runs, or ones started within the
  last 30 days, whichever is fewer (`OPTIMIZATION_RUNS_RETENTION_LIMIT`/`_DAYS`,
  `functions/src/optimizationMonitoring.ts`) - nothing is ever deleted. This runs every 2 minutes, so
  the collection grows without bound until a scheduled function removes old runs, which needs the
  Blaze plan (the project is on Spark) - the same known gap as the geocoding/routing caches and trip
  request coordinates above. When Blaze is available, add a scheduled function that deletes runs
  older than 30 days (or beyond the 500th newest), the same pattern as those other retention items.
- Two of the spec's own example fields (section 24) are never shown, because neither is a real number
  this system computes: a per-decision "compatibility %" (no such score exists anywhere in the
  matching or optimization code), and "passenger walking distance" (a preference ceiling set at
  trip-request time, module 5.2, never recomputed live during a match). Seats used is shown per plan
  (the request count against the journey's own seat capacity), not per decision.
- A decision's own status is the optimizer's proposal, not a live cross-check against what was
  actually written to Firestore (a rare race - another change landing first - can make a proposed plan
  not apply; this is not reconciled per decision). `finalAssignments`/`journeysMatched` on the run
  itself are the real, applied counts.

### Reading and refunding payments (staff)

- Any verified staff role reads trips by payment status through `listPayments`/`getPaymentsSummary`
  (module 11.10) - visibility only, the same list-row shape (no exact place) trip monitoring and
  disputes already use, and the same audited `getTripDetail` for a trip's own amounts. There is no
  separate `payments` collection: every payment field lives on the trip request itself.
- Only `ADMIN`/`SUPER_ADMIN` may issue a refund (`refundPayment`) - a financial decision, the same
  `REVIEWER_ROLES` split user management uses (other staff roles see the page, only reviewers act).
  This wires `refundTripPayment` (module 9.7, fully built and tested but never called from anywhere
  until now) to a real caller: the real staff uid as `actor` and their own typed reason folded into
  the audit entry it already writes, in place of the placeholder `'system'` actor used everywhere else
  that function is still called with none (nothing else calls it with an actor yet).
- The summary is platform-wide totals only (captured, refunded, platform fee), computed with a
  Firestore aggregation query, not a per-document read. No trend or time breakdown: that is Phase 12's
  own job (its metrics list already names "payment success rate" as an Analytics concern).

### Reading analytics (staff)

- Any verified staff role reads the platform-wide totals through `getAnalyticsSummary` (module 12,
  Phase 12's own 12-metric list) - visibility only, computed on demand from existing collections, no
  new one. Exactly Phase 12's named metrics, no more, no fewer: "network efficiency" belongs to
  section 23's own live dashboard instead (see "Reading the live network", below), and the fuller
  section 78/33 metric sets stay a later, separate decision.
- "Average passenger walking distance" is never shown - no live walking-distance number is computed
  anywhere in this codebase, the same stance module 11.9 already takes for "compatibility %" and
  walking distance, rather than presenting a passenger's own preference ceiling as a measured outcome.
- "Average occupancy", "Vehicle trips avoided" and "Estimated emissions avoided" use formulas this
  project chose itself, not an industry-standard one - documented in full in
  `functions/src/analytics.ts`'s own header comment and shown on the page itself. Emissions is
  labeled prominently as an estimate with an unverified methodology (spec section 33's own
  requirement): vehicle trips avoided × this system's own average trip distance × an assumed 120 g
  CO₂/km per car.
- "Average matching time" and "Average detour" both depend on data that started being recorded only
  with this module (`tripRequests.matchedAt`/`matchDurationSeconds`, written by
  `optimizationRun.ts`'s phase 1 and `planInsertion.ts`'s phase 2; and module 11.9's own
  `optimizationRuns` log) - neither is retroactive, and detour is further limited to whatever cycles
  11.9's own retention window still holds.
- Distinct passenger/vehicle counts (`peopleTransported`/`vehiclesUsed`) read the **newest 5,000**
  `COMPLETED` trip requests (`ANALYTICS_DISTINCT_TRIP_CAP`, Phase 14 performance), both from one read
  (Firestore has no count-distinct aggregate). Up to 5,000 completed trips they are exact. Beyond that
  they are lower bounds and the summary says so (`distinctCountsCapped`, shown as a note on the
  Analytics page), and the two figures made from them - **vehicle trips avoided and the emissions
  estimate - are withheld (`null`, shown as a dash)** rather than shown wrong, because
  `max(0, people - journeys)` against the all-time journey count would quietly read 0. The real cure at
  that scale is a running counter, not a bigger cap. `docs/performance.md` has the rest of the audit.

### Reading the live network (staff)

Module 11.5's own first pass (vehicles only) deferred three things pending their own explicit
decisions: pickup/drop-off/unmatched-request map markers, the high-demand heatmap, and "current
network efficiency" (section 23 names all of these; none had a methodology). All three now exist:

- **Map markers and heatmap.** Showing every open trip's place at once is exactly the kind of
  unaudited, aggregate exposure this codebase otherwise refuses - `tripMonitoring.ts`'s own list
  views, and the Firestore rules themselves, draw a hard line that no trip LIST view ever carries an
  exact place, only the single-trip audited `getTripDetail` call does. The resolution here:
  `listActiveTripPositionsForStaff` (`functions/src/liveNetwork.ts`) rounds every pickup/drop-off to
  the same ~11 m precision `reverseGeocode` already uses (`roundForGeocoding`) before it is ever read
  into the response - this endpoint never has the exact place to begin with, so it is not audited,
  the same stance `listActiveTripsForStaff` already takes. The high-demand heatmap is built from the
  same rounded positions, binned into a coarse grid client-side - a heatmap needs no exact point for
  any single trip either. "Unmatched" (no driver yet) is carried as a plain boolean so the admin map
  can style those markers differently (section 48's own "Unmatched request" marker type) without a
  second endpoint.
- **Network efficiency.** No formula exists anywhere in the spec for this one (section 23 names it;
  section 78's own, separate "Transportation efficiency" metrics are a later decision, same as
  analytics' own stance above). This project's own definition: the share of right-now
  MATCHING/ACTIVE journeys (ones that have actually picked up at least one passenger - an AVAILABLE
  journey has picked up nobody yet, so it is excluded from both sides of the fraction) carrying more
  than one passenger. Computed entirely client-side from `ActiveVehicle`'s own new `passengerCount`
  field (the length of `driverJourneys.matchedTripRequestIds`, already staff-readable) - a genuinely
  live number, not Phase 12 Analytics' own cumulative/historical average occupancy.

## Your own data: export and account deletion (passengers and drivers, Phase 14)

Spec section 56 asks for deletion workflows. `exportMyData` and `deleteMyAccount` are callables for a
verified passenger or driver acting on their own account only; there is no staff path and no way to
name another account. The same two callables serve both: a driver's goes by the caller's signed role to
`functions/src/driverDataRights.ts`, and anyone else reaches the passenger's `functions/src/dataRights.ts`,
which refuses everything but a verified passenger. Both apps reach them from a "Privacy and data"
section on the Profile tab (`packages/mobile-auth/src/screens/PrivacySection.tsx`, the wording differs by
role): the web build downloads the export as a `.json` file, a phone opens the share sheet, and deletion
is two steps (a dialog saying what goes and what stays, then typing `DELETE`), after which the app
returns to the welcome screen. A server refusal is shown as written.
`packages/firebase/src/dataRights.ts` has the client wrappers.

Both share: every export and deletion is limited (5 exports and 3 deletion attempts an hour, every
attempt counting, valid or not); deletion needs `confirm: "DELETE"`; each step of a deletion tolerates
having already happened, so calling it again finishes a half-done one; and the audit entries
`ACCOUNT_DATA_EXPORTED` and `ACCOUNT_DELETED` hold the uid only, never a name, an email, a plate or any
data. An export is an explicit allow-list, never a raw document dump, at most 500 of each kind with
`truncated` when that cut something off.

### Passengers

- **Export.** The profile (name, email, phone, status, whether a card is saved), each trip request
  (status, times, the places while they still exist, distance, fare, refund, payment status), receipts
  and notifications. It leaves out another person's data (the driver's name, plate and position) and
  internal bookkeeping (platform fee, tokens, Stripe ids).
- **Deletion is refused**, changing nothing, while a ride is open or in progress, a payment hold is
  outstanding (`AUTHORIZED`), or a dispute is unreviewed; and when a Stripe customer exists but Stripe
  cannot be reached or refuses.
- **Order, so a failure leaves something safe to retry:** delete the Stripe customer (the saved card
  reference), then anonymize every trip request and receipt, then delete the notifications and the
  profile, write `ACCOUNT_DELETED`, and last delete the sign-in account.
- **Anonymized, not deleted (decided with the user).** A trip request keeps its status, fare, payment
  fields and ids, because fares, refunds and disputes are financial records that have to be kept. What
  goes: `passengerId` becomes `null`, the name becomes "Deleted passenger", the exact places and the
  matched driver's last position are cleared and the request is marked `placesCleared`. A receipt keeps
  its amounts with `passengerId` set to `null`. The passenger can no longer read these (the read rule
  needs `passengerId` to match), and staff see "Deleted passenger".

### Drivers

- **Export.** The profile, the driver profile (verification, availability, rating, trip count), the
  vehicle (including the plate), their journeys (status, the start and end points while they exist,
  how many passengers), earnings entries (trip, amount), the rides they drove (status, times and fare
  only) and notifications. **Never a passenger's name, places or payment detail.**
- **Deletion is refused**, changing nothing, while the driver is online, has a journey that is
  `AVAILABLE`, `MATCHING` or `ACTIVE`, drives a ride still in flight, has a payment hold outstanding on a
  ride they drove, or has an unreviewed dispute on one. A driver who is merely offline with only ended
  journeys can delete.
- **Order:** take the driver out of every passenger's trip record, then anonymize the earnings ledger
  and clear the places and the link from their journeys and route plans, then delete the notifications,
  vehicle, driver profile and user profile, write `ACCOUNT_DELETED`, and last delete the sign-in
  account. There is no Stripe step: no driver payout account exists (driver payouts are deliberately not
  built), so nothing outside Firestore holds a driver's details.
- **What happens to the passengers' records (decided with the user).** On every ride the driver drove,
  `matchedDriverId`, `driverName`, the vehicle's type, make, model and plate, and `driverLocation` become
  `null`. The ride itself, its fare and payment fields, and everything of the passenger's, are untouched.
  The consequence: a passenger can no longer see who drove a past ride, and staff trip views show no
  driver for it.
- **Anonymized, not deleted.** Earnings entries keep their trip, amount and currency with `driverId` set
  to `null`, the same decision as the passenger's receipts (financial records are kept). Journeys keep
  their status and matched ids but lose `driverId`, `vehicleId`, the start and end points and the last
  position; route plans lose `driverId` and hold only request ids, stop kinds and totals (no
  coordinates), so they hold nothing else to clear.
- **The plate is freed.** Deleting the vehicle document frees its plate for another driver, since the
  one-plate-one-vehicle rule is a query on the vehicles themselves.

### Deliberately not removed, and before launch

- **Audit entries keep the account's uid as the actor** (an audit trail that can be edited is not one;
  with the profile gone the uid alone identifies nobody), and the per-account rate limit counters hold
  only a uid and a count.
- Analytics' "distinct passengers" figure loses a deleted passenger, since the id is gone.
- **Driver journeys are on the same 30-day clock as trip requests** (see the retention item above), so a
  driver does not have to delete their account to have a finished journey's start and end points
  removed. A journey that never ended (a kept `DRAFT`) is the one gap: it holds its places until the
  driver declares a new destination or deletes the account.
- **Backups keep a deleted account for up to 14 days, and a restore brings it back** (`docs/backup.md`,
  "Backups and the right to delete"). Both deletion functions therefore also write one structured
  `ACCOUNT_DELETED` entry to Cloud Logging, which a restore does not undo, holding the uid and the role
  and nothing else. It is the record to re-apply deletions from after a restore. **No tool re-applies
  them yet**, and none of the backup settings are turned on (the project is on the Spark plan).
- **Before real people use it:** the privacy notice must describe this (including the 14 days of backups),
  and the wording of what is kept (financial records, audit trail) should be reviewed for the launch
  jurisdiction (spec section 56).

## Rate limiting (Phase 14 hardening)

A Phase 14 security audit found rate limiting covered only `calculateRoute`/`reverseGeocode`
(`functions/src/lookupLimits.ts`, protecting the OSRM/Nominatim call budget, not abuse) - every
mutating callable had none. `functions/src/callLimits.ts`'s own `enforceCallRateLimit` closes that
gap: a Firestore-backed sliding-window counter, keyed per `(scope, caller)`, that throws
`resource-exhausted` once a caller exceeds their own ceiling within the window. A caller that cannot
be counted (the transaction fails under load) is treated as over the limit - fail closed, the same
stance `lookupLimits.ts`'s own `claimLookup` already takes.

Wired into (all generous ceilings for a real user, invented and documented at each call site, not
measured against real traffic - there is none yet):

| Callable(s)                                                                           | Scope                                                           | Limit     |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------- |
| `completeRegistration`                                                                | `completeRegistration`                                          | 5 / 5 min |
| `createTripRequest`                                                                   | `createTripRequest`                                             | 10 / min  |
| `cancelTripRequest`                                                                   | `cancelTripRequest`                                             | 10 / min  |
| `setAvailability`                                                                     | `setAvailability`                                               | 20 / min  |
| `headToPickup`, `confirmPickup`, `startTransit`, `approachDropoff`, `completeDropoff` | `tripExecution` (shared - all 5 funnel through one `advance()`) | 30 / min  |
| `savePaymentMethod`                                                                   | `savePaymentMethod`                                             | 10 / min  |
| `updateDriverLocation`                                                                | `updateDriverLocation`                                          | 120 / min |

`updateDriverLocation` already had a separate, WRITE-level throttle
(`LOCATION_THROTTLE.serverMinIntervalMs`, 15 s) that answers a too-fast update with a cheap
`{status: 'throttled'}`, never an error - a real GPS client never comes close to the 120/min
invocation ceiling above it; that one exists only to bound the cost of a client calling the function
itself far faster than any real device would, refusing outright rather than the graceful shape.

## App Check (Phase 14 hardening)

The same audit found App Check configured nowhere - client or server. `enforceAppCheck`
(`functions/src/appCheck.ts`'s own `enforceAppCheckFromEnvironment`, wired into every `onCall`
function via `setGlobalOptions`) is now available, from `ENFORCE_APP_CHECK`, unset (or anything
other than `'true'`) meaning off - the same convention as `OPTIMIZATION_SERVICE_URL`/
`STRIPE_SECRET_KEY`. **This must stay off (the default) today**: verified directly against the
Functions emulator that turning it on with no client anywhere sending an App Check token - true of
every test in this repo, and of every real app today - answers every single callable with a flat 401. It can only be turned on once BOTH a real deployment exists AND every client app
(admin/driver/passenger) initializes the App Check SDK with a real provider (reCAPTCHA/Play
Integrity/App Attest, spec section 57) - neither exists yet (the project is still on the Spark plan,
see below). Wiring the switch now, rather than only once both are ready, means turning it on later
is a one-variable change, not new code.

## Failure recovery (Phase 14 hardening)

A follow-up audit found three one-shot Cloud Function triggers that fire only on a status
TRANSITION, with nothing else watching the state a failed attempt leaves behind:
`matchTripRequestOnCreate` (REQUESTED → SEARCHING), `routeModificationOnDelay` (a MATCHING journey
newly flagged delayed - the flag is rewritten on every location update while a driver stays behind
pace, not only on change, so `before` is never null a second time), `voidStaleAuthorizationOnRelease`
(a trip released back to SEARCHING/CANCELLED while still AUTHORIZED). Unlike a SEARCHING trip request
(already re-swept every 2 minutes by `batchOptimizationRun`) or the Stripe webhook (Stripe itself
retries a non-2xx response for days), none of these three had an equivalent backstop.

`functions/src/failureRecovery.ts` adds one scheduled sweep per trigger, each reusing the exact same
idempotent function its own real-time trigger already calls
(`matchTripRequest`/`reoptimizeDelayedJourney`/`voidStaleAuthorization` all safely no-op on state that
no longer needs them), so a sweep can never do anything the real-time path would not also have done -
it only gives a failed attempt another chance:

| Sweep                            | Cadence     | Threshold                                      |
| -------------------------------- | ----------- | ---------------------------------------------- |
| `retryStuckRequestedTripsSweep`  | every 2 min | REQUESTED trips older than 5 min               |
| `retryDelayedJourneysSweep`      | every 2 min | every MATCHING journey still flagged delayed   |
| `retryStaleAuthorizedHoldsSweep` | every 5 min | AUTHORIZED holds released more than 10 min ago |

The stale-hold sweep is not closing a "never resolved" gap the way the other two are -
`voidStaleAuthorization`'s own doc comment already named Stripe's own hold expiry (about a week) as
the existing fallback for a failed void. It exists to free a passenger's card hold within minutes
instead of leaving it to that week-long expiry, a genuine improvement rather than a new safety net.

### What section 53 asks of the screens, and was not checked

Section 53 wants nine states for every important operation (success, loading, empty, validation
error, network error, server error, permission error, timeout, retry) and no raw technical error
shown to a person. What was checked is the backend half above (the sweeps, and the real error being
logged). **Not checked: the nine states on every screen.** What a search found is a loading state in
about thirty files, a `retryable` flag with a "Try again" button in about fourteen, and error text
that comes from mapped messages (`AuthFailure.message`), but nobody went through each screen and
checked each state, and one message (`PlaceRejectedError.message` in the place search) is shown as
it is without checking that it is always written for people. This is a UI audit, not a correctness
risk for data, and is left for a later UI-polish pass.

## Monitoring / observability (Phase 14 hardening)

A third audit checked the actual logging code against spec section 54's own list: most of the named
metrics (unmatched requests, average occupancy, average detour, payment failures, per-run
optimization latency) are already covered by Phase 12 Analytics or an existing admin page - see that
section's own definitions above. Two real gaps were found and fixed (a third, the `requestId` and `planId` IDs, in a later change), all pure logging changes, no
new metrics or UI:

- **The correlation IDs section 54 asks for didn't correlate.** `optimizationRunId` - the
  `optimizationRuns/{id}` document every batch run already wrote - was generated but never logged
  anywhere, so a Cloud Logging entry for a run could not be traced back to its own full Firestore
  record. `writeOptimizationRunLog` (`optimizationMonitoring.ts`) now returns that document's own ID;
  `runBatchOptimization`'s own `BatchOptimizationOutcome` carries it as `optimizationRunId`, and
  `index.ts`'s own `logger.info('Batch optimization run finished.', outcome)` (and the immediate-run
  equivalent) logs it automatically as part of `outcome`. `tripId`/`journeyId` were already logged at
  most catch sites in `index.ts`; the one missing one (`optimizationRunOnSearching`'s own failure
  log) now carries `tripId` too.
- **Swallowed exceptions lost the actual error.** Of the roughly ten `logger.warn`/catch sites across
  every "never throws" trigger in `index.ts`, only the Stripe webhook handler logged the real `error`
  object - every other one (batch optimization, all three Phase 14 sweeps, route modification, the
  stale-hold void, trip estimate/search) logged a bare generic message with no exception detail. A
  real production failure at any of these sites would show only THAT it happened, never WHY. Every
  one of those catch blocks now captures and logs `error` alongside its own message.

- **`requestId` and `planId` are now in the logs.** The run outcome that is logged
  (`BatchOptimizationOutcome`) carries `requestIds` (the requests the run assigned, matched or
  inserted) and `planIds` (the `journeyPlans` documents it wrote), next to `optimizationRunId`, so a
  request or a plan found in Cloud Logging can be traced to the run that made it and the other way
  round. The route re-ordering after a delay logs the new `planId` next to its `journeyId`, and the
  delayed-journey sweep logs the `planIds` it wrote. Only ids, never a place. In this codebase a
  "request" is the trip request, so `requestId` and the `tripId` already on the estimate and search
  logs are the same value; those logs keep `tripId` rather than carry the same id twice.

### Section 54 against the code

| Section 54 asks for                                                  | State                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Optimization latency                                                 | Covered per run: `executionTimeSeconds` on every `optimizationRuns` document (the `/optimize` call only, not the whole cycle). No trend across runs.                                                                                                                                                                                                            |
| Unmatched requests                                                   | Covered: Analytics, as a live snapshot (not a historical count).                                                                                                                                                                                                                                                                                                |
| Average occupancy, average detour                                    | Covered: Analytics.                                                                                                                                                                                                                                                                                                                                             |
| Payment failures                                                     | Partly: Analytics shows the payment success rate; failures are not counted on their own.                                                                                                                                                                                                                                                                        |
| Matching success rate                                                | **Not built.** A single percentage needs a denominator someone has to define (a request cancelled before it was ever offered, one that matched on the second run), and nothing records the unmatched ones historically, only the live snapshot and each run's reasons. Same stance as Phase 12: no real data to show, so no number rather than an invented one. |
| Average walking distance                                             | **Not built.** No walking distance is computed anywhere (Analytics skips it for the same reason); showing a passenger's own preference ceiling as if it were measured would be wrong.                                                                                                                                                                           |
| API errors                                                           | **Not built.** There is no one place API errors pass through: the apps call 41 callables and Firestore directly, and a callable's error goes back to the caller and is not recorded. Counting them would mean wrapping every callable, a separate decision.                                                                                                     |
| Cloud Function failures, route calculation failures                  | Not counted yet: they are logged (the real error, with `tripId`/`journeyId`) but nothing aggregates them. A separate change (an Operations page with daily counters) is planned; until it exists there is no count. Even then a function that crashes or times out without reaching a `catch` cannot be counted from inside.                                    |
| Correlation IDs `requestId`, `tripId`, `optimizationRunId`, `planId` | Covered as described above.                                                                                                                                                                                                                                                                                                                                     |

## Operations counters (Phase 14 hardening)

Two kinds of failure were only ever logged, never counted, so no one could say how many there were:
a route lookup that gave no route, and an exception that a Cloud Function trigger or sweep caught.
The Operations page (admin console, any verified staff role) now shows both, for today and the last
seven UTC days, through the callable `getOperationsSummary`. It is deliberately not part of
Analytics, whose list is fixed at Phase 12's twelve metrics.

- **What is counted** (`functions/src/opsCounters.ts`): `route-unavailable` (the routing server failed
  or did not answer), `route-busy` (the usage limits refused the lookup; normal limiting, shown
  apart from the failures), and `function-failed:<name>` for each exception caught by the Stripe
  webhook, the estimate and search triggers, the batch run (scheduled and immediate), the delay
  re-ordering, the stale-hold void, the three recovery sweeps and the retention sweeps. A route with
  no road route (`none`) is not a failure and is not counted. A lookup is counted each time it is
  refused or fails, so one request refused four times counts four.
- **What is stored:** one increment on a counter document of the day, `opsCounters/{UTC day}_{shard}`,
  holding the day and counts by kind. No uid, no trip, no place. The day is split over 10 shards
  so that a burst of refusals does not pile onto one document (the route counter itself once did,
  docs/load-testing.md); the page adds the shards up. The collection is not in the rules, so it is
  closed to every client (a rules test checks it).
- **Best effort, never in the way.** `recordOpsEvent` never throws: a counter that cannot be
  written is a missed count, not a failed trip or a failed trigger (a test makes the write fail and
  checks this). Counts can therefore be missed but are never invented. The cost is one small write
  per refused or failed lookup, which for a batch run under the real limits can be thousands of
  writes a run (docs/load-testing.md, scenario B); that has not been measured on a real project.
- **What cannot be counted:** a function that crashes, runs out of memory or times out never reaches
  its `catch`, so it is not here. Those are in Cloud Logging and Cloud Monitoring only. The page says
  this in a note, because a zero on it must not be read as "nothing is wrong".
- **How the catch sites are checked:** the catch blocks are "never throws" wrappers around code that
  handles its own failures, so a real exception cannot be provoked in them on the emulators. A test
  therefore reads `functions/src/index.ts` and fails unless every failure log
  (`logger.warn`/`logger.error`) is immediately preceded by a `recordFailure` call; it was checked
  to fail when one is removed. The counting of route lookups is tested for real (a failing provider
  is `unavailable`, a refused lookup is `busy`, found, no route and cached are not counted).
- **Views and retention:** "today" is the UTC day so far, not a trailing 24 hours (counters are daily,
  so an exact trailing 24 hours cannot be made from them); "last 7 days" is today and the six UTC
  days before it. Counter days are kept 30 days and a daily scheduled sweep
  (`clearExpiredOpsCountersSweep`) deletes older ones, a batch at a time. Like the other sweeps it
  needs the Blaze plan to run; nothing is deployed on Spark.

## Tests

- `npm test`: input validation, and a parity test that keeps `functions/src/roles.ts` aligned with
  `@ridemesh/types` (functions deploy from their own directory, so they cannot import the shared
  package).
- `npm run test:integration`: starts the Auth, Functions and Firestore emulators and runs the real
  rules file, the real function and the real script. It covers role assignment, escalation
  attempts, role switching, repeat calls, unverified email, cross-user reads, blocked writes, staff
  access and the script's safety checks. The rules tests were mutation-checked by loosening the
  rules and confirming they fail.

## Known limitations (planned later)

- Rate limiting now covers every mutating callable (see "Rate limiting" above) and App Check is
  wired but deliberately off by default (see "App Check" above) - turning App Check on waits on a
  real deployment and every client app's own SDK initialization, neither of which exists yet.
- Password minimum length is enforced by the apps, not by Firebase Auth itself (see above). This
  is a known gap to close when the project moves to the Blaze plan and Auth password policy can be
  enabled.
- Password resets use Firebase's default email and hosted page, which enforce the 6-character
  minimum rather than 8 (see Password reset).
- Session tokens are kept in AsyncStorage on phones, which is not encrypted storage.
- Native session persistence is verified by the Android bundle containing the React Native storage
  implementation and by web tests; it has not been exercised on a physical device or simulator.
- `status` (`ACTIVE`, `SUSPENDED`) enforcement shipped with the admin module (module 11.3,
  `setUserStatus`) - it now gates most passenger/driver actions (`availability.ts`, `journeys.ts`,
  `locations.ts`, `paymentMethods.ts`, `registration.ts`, `tripExecution.ts`, `tripRequests.ts`,
  `vehicles.ts`).
- Staff roles differ by action, not just by page: any verified staff role can view (trip monitoring,
  optimization monitoring, payments, analytics, audit logs, the Phase 13 AI predictions page); only
  `ADMIN`/`SUPER_ADMIN` (`REVIEWER_ROLES`) can take a reviewing/financial action (driver/vehicle
  review, refunds).
- Functions are tested on the local emulators only. They are not deployed because the project is on
  the Spark plan, which cannot deploy Cloud Functions.
