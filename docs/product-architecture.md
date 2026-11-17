# Two-product architecture

Status: draft for review. This describes the plan; none of the new parts exist yet.

## 1. Repository decision: stay in the monorepo

The repository is already an npm-workspaces monorepo with shared `packages/types`, `packages/firebase` and
`packages/mobile-auth`. Splitting into two repositories would force those packages to be published or duplicated, and Product A
is built directly on the existing matching engine, which lives in `functions/` and `services/`. So:

- One repository, two independent products.
- Each product gets its own apps, its own Cloud Functions group and its own docs.
- Products share only low-level packages (types, UI, Firebase client). **Neither product imports the other's code.**
- Product B (later) talks to the ride engine only through a narrow, versioned interface. See section 7.

```
apps/
  passenger, driver, admin      existing, unchanged
  corporate/                    NEW  Product A, company admin web console (Next.js)
  employee/                     NEW  Product A, employee mobile app (Expo)   [see decision D1]
packages/
  types, firebase, ui, ...      existing, shared
  tenancy/                      NEW  company/membership types and helpers (pure TS)
  voice/                        NEW  voice menu engine + adapters (pure TS core)
functions/src/
  (existing files)              extended with a tenant filter
  corporate/                    NEW  company, invitation, membership, dashboard functions
```

### D1. Employee app: new app or reuse the passenger/driver apps? (Decided 2026-11-17: new app)

Recommendation: a **new `apps/employee`** Expo app that composes existing `packages/mobile-auth` screens and the existing
trip/journey callables. Reasons: the consumer apps stay untouched (your requirement); an employee is both rider and driver, which
neither app models; voice needs its own screens. Cost: some UI duplication, kept low by sharing packages. Alternative: add a
"company mode" to the existing apps. That is less code but changes apps you want to leave alone. Confirm at review.

## 2. Tenancy model

Add a company layer without touching consumer behavior.

**Data**

- `companies/{companyId}`: name, sites, settings, status, createdAt.
- `companies/{companyId}/members/{uid}`: companyRole (`COMPANY_ADMIN` | `EMPLOYEE`), status, joinedAt.
- `companyInvitations/{inviteId}`: companyId, email, tokenHash, expiresAt, status. Only the **hash** of the token is stored.
- `users/{uid}.companyId` (nullable; null for every consumer user, so existing data stays valid).
- `tripRequests` and `driverJourneys` get `companyId` (nullable). Written by the server from the caller's claim, never from client input.

**Identity.** The signed Firebase token carries `companyId` and `companyRole` as custom claims, set only by server code (as
`role` is today, in `registration.ts` / `staff.ts`). Security rules compare claims, never a field inside a document.
`companyRole` is separate from `role`, so existing rules and the admin console keep working.

**Rules.** New collections default-deny like the rest. Company admins read their own company and its members. Employees read
their own membership and company name. Nobody reads another company. `tripRequests` privacy is unchanged.

## 3. The central invariant: no cross-company matching

Every place that picks candidates must filter on the same `companyId` (null matches only null, so consumers match only consumers):

**Caveat found in A1, to be solved in A3.** Firestore's `== null` matches only documents where the field exists and is `null`; it does
not match documents where the field is missing. Existing consumer `tripRequests` and `driverJourneys` have no `companyId` field at all,
so a plain `where('companyId', '==', null)` would find none of them. A3 must either write an explicit `companyId: null` on every new
consumer document and backfill existing ones, or filter consumers differently. This is decided in the A3 design note, with a test that
consumer matching still finds consumer documents.

| Site                                                    | Change                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `matching.ts:134` (available journeys for a request)    | add `.where('companyId', '==', request.companyId)`                               |
| `optimizationRun.ts:172, 221` (batch run)               | partition requests and journeys by `companyId`; run the optimizer once per group |
| `planInsertion.ts:131` (insert into a MATCHING journey) | same filter                                                                      |
| `passengerConstraints.ts` / any other candidate loop    | audit during module A3                                                           |

This is enforced and tested at the function layer (server-side), and by a dedicated test that seeds two companies and a consumer
group with overlapping routes and asserts zero cross-matches. New composite Firestore indexes are required and will be added to
`firestore.indexes.json`.

## 4. Functions (Product A)

Callables (all validate input with shared zod schemas, check claims server-side, write audit entries):
`createCompany`, `updateCompanySettings`, `inviteEmployee`, `revokeInvitation`, `acceptInvitation`, `removeEmployee`,
`getCompanyDashboard` (aggregates), `listEmployees`, plus reuse of the existing `createTripRequest`, `declareDestination` and trip
execution functions, which gain the tenant stamp. Accept/reject (Q3) adds `respondToMatch`.
Rate limits reuse the existing call-limit helpers (`callLimits.ts`).

## 5. Company dashboard (`apps/corporate`)

Next.js + Tailwind, same stack as `apps/admin` (no new tech). Sign-in accepts only `COMPANY_ADMIN`. It reads aggregates through
callables, never trip documents, so the existing "nobody can read trip places" rule is not weakened.

## 6. Voice architecture (free, on-device)

Principle: a pure-TypeScript core that can be unit-tested, with thin platform adapters, so nothing about the voice
logic depends on a device.

```
packages/voice
  core/        VoiceMenu state machine, intents, confirmation flow, transcript log   (pure TS, fully unit-tested)
  output/      SpeechOutput interface  ->  adapter: expo-speech (OS text-to-speech, free)
  input/       SpeechInput interface   ->  adapter: on-device recognizer (see spike), plus a "not available" adapter
  announce/    maps app events (match found, driver arriving, ...) to spoken text, with captions
```

- **Output:** `expo-speech` uses the operating system's built-in text-to-speech. It is free and works offline for installed voices.
- **Input:** the Expo SDK has no built-in speech recognition. A community module wrapping the OS recognizers
  (Android `SpeechRecognizer`, iOS `SFSpeechRecognizer`) is the likely option, and it needs a development build, not Expo Go. Offline
  recognition depends on the device and language pack. **This is unverified. I will run a short spike (install, build, test on an
  emulator/device) and report exactly what works before building menus on top of it.** If it fails, voice input is reported as not
  available and the menu remains usable by touch, with spoken output still working.
- **Design rules:** every voice action has a touch equivalent; state-changing actions need spoken confirmation; spoken text is
  always shown as a caption; the user can disable voice; the app reports recognizer availability honestly.
- **Not possible with this approach:** speaking while the app is closed, or phone-call menus. Documented as a limit, not hidden.
- **Tests:** the menu/intent/confirmation core gets unit tests. Adapters are tested with fakes; real speech is verified manually on
  a device and reported separately, per your instruction.

## 7. Product B boundary (planned, built later)

- Separate app (`apps/developer`) and function group (`functions/src/integrations/`), its own collections
  (`integrationClients`, `apiKeys` stored as hashes, `webhookEndpoints`, `deliveryLogs`).
- Connectors are modules behind one interface (`validateConfig`, `mapInbound`, `mapOutbound`, `send`); the core never names a
  specific service.
- It reaches the ride engine only through a small internal service layer ("ride gateway") that Product A also uses, so
  neither product reads the other's collections.
- Public REST surface (HTTPS functions) with hashed API keys, scopes, rate limits, signed outbound webhooks, retries with
  backoff, and delivery logs. It will not claim any third-party service connects automatically. Each connector is limited by that service's real API.
- This will get its own requirements doc after Product A is accepted.

## 8. Delivery plan for Product A (one module at a time, each its own branch and PR into `develop`)

| Module | Content                                                                                           | Gate                             |
| ------ | ------------------------------------------------------------------------------------------------- | -------------------------------- |
| A0     | Baseline: re-run unit/integration suites, fix known flakes noted in the audit, refresh stale docs | Green baseline recorded          |
| A1     | `packages/tenancy` types, `companies`/members/invitations model, claims, rules and rules tests    | Isolation tests pass             |
| A2     | Company creation, invitations, accept flow, employee management (functions + tests)               | Integration tests                |
| A3     | Tenant stamp on requests/journeys, tenant-filtered matching/optimization, no-cross-match test     | Cross-company test passes        |
| A4     | `apps/corporate`: sign-in, company settings, employees, invitations                               | UI tests, responsive check       |
| A5     | `apps/employee`: onboarding, ride offers/requests, accept/reject, upcoming rides, notifications   | e2e journey                      |
| A6     | Voice spike, then `packages/voice` core, announcements and menu                                   | Honest voice report              |
| A7     | Corporate dashboard aggregates and statistics                                                     | Privacy test (no places exposed) |
| A8     | End-to-end journey, security checks, bug report, docs, launch-readiness report                    | Your acceptance                  |

**Regression gate (required, 2026-11-17).** Every module from A1 on ends with a full run of the existing RideMesh unit
(`npm test`) and integration (`npm run test:integration`) suites, plus typecheck and lint. All must pass before the next module
starts. A failure caused by the tenancy layer is fixed first, not deferred. A known pre-existing flake is accepted only after it
passes when re-run on its own, and is named in the report. A0 records the baseline these runs are compared against.

After A0, each module ends with the standard report you already use (Completed / Files changed / Architecture / Tests / Lint /
Type check / Firebase / Git branch / Commit / Git push / Next module / Questions).

## 9. Technical decisions to record

1. Monorepo with two independent products (section 1).
2. Tenancy via custom claims plus a nullable `companyId` on existing documents, so consumers are unaffected.
3. Tenant filtering at the query layer, enforced by tests, not by UI.
4. Voice core is pure TS with swappable adapters; free OS speech only.
5. Dashboard shows aggregates only.
6. Invitation tokens stored hashed, single-use, expiring.
