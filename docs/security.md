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
- **Fare, distance and duration are `null`** until routing and pricing exist (Phase 4 onwards).
- **Retention: 30 days after a request ends (decided, NOT yet implemented).** The policy is that a
  trip request's exact coordinates and addresses are deleted 30 days after it is COMPLETED or
  CANCELLED (spec section 56). **Nothing deletes anything today**: every request stays after it
  ends, because automatic deletion needs a scheduled Cloud Function, and scheduled functions need the
  Blaze plan (the project is on Spark). This is a known limitation until then. When Blaze is
  available, add a scheduled function that finds requests whose end time is more than 30 days ago
  and removes them (or clears their places, if the trip record is still needed for fares and
  disputes: decide that with the payments module), audits the run without naming places, and has a
  test on the emulators. The end time is not stored on the request yet (only `updatedAt`, which
  changes on every write), so that change should also add an explicit `endedAt` written by the
  functions that complete or cancel a request. Until then a passenger cannot delete their own requests
  and no export or erasure flow exists (also spec section 56). The privacy notice must state the
  30 days before real passengers use the app.

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

- No App Check or rate limiting on `completeRegistration` yet (Phase 14 hardening).
- Password minimum length is enforced by the apps, not by Firebase Auth itself (see above). This
  is a known gap to close when the project moves to the Blaze plan and Auth password policy can be
  enabled.
- Password resets use Firebase's default email and hosted page, which enforce the 6-character
  minimum rather than 8 (see Password reset).
- Session tokens are kept in AsyncStorage on phones, which is not encrypted storage.
- Native session persistence is verified by the Android bundle containing the React Native storage
  implementation and by web tests; it has not been exercised on a physical device or simulator.
- `status` (`ACTIVE`, `SUSPENDED`) is stored but not enforced by rules or functions until the admin
  module.
- Staff roles all have the same read-only access for now; per-role permissions are defined in the
  admin module.
- Functions are tested on the local emulators only. They are not deployed because the project is on
  the Spark plan, which cannot deploy Cloud Functions.
