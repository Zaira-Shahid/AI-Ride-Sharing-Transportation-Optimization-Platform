# Roles, access and security

Status: through Module 2.3 (vehicle capacity). Module 1.1 defined the role system and Firestore
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
  their rating or trip count, or go online. Staff have read access only for now; how staff change
  verification is decided in Module 2.4. Later Phase 2 modules open only the specific fields each
  one owns.
- A new driver starts `PENDING` and `OFFLINE`, with rating `null` and 0 trips; detour settings stay
  `null` until the driver sets them.
- Creation writes a `DRIVER_PROFILE_CREATED` audit entry.
- Nothing about a driver's verification is enforced elsewhere yet. Access to journeys and matching
  will check it in the modules that own them.

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
- The number of seats is the driver's own claim until verification (Module 2.4) checks it. Nothing
  compares it to the make and model yet.
- No proof of ownership, registration document or plate lookup exists yet; verification is
  Module 2.4. Until then a plate is only checked for shape and uniqueness.

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

| Collection       | Read                                                     | Write                                         |
| ---------------- | -------------------------------------------------------- | --------------------------------------------- |
| `users/{uid}`    | Own profile, or any profile for verified staff (4 roles) | Owner may update name and phone only (ACTIVE) |
| `drivers/{uid}`  | That driver, or any driver profile for verified staff    | Nobody                                        |
| `vehicles/{uid}` | That driver, or any vehicle for verified staff           | Nobody (the saveVehicle function only)        |
| everything else  | Nobody                                                   | Nobody                                        |

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
