# Project audit (starting point for the two-product work)

Status: draft for review. Written 2026-11-17 against `origin/develop` at 5519be6.

**How this audit was done, and its limits.** It is based on reading the repository structure, `firestore.rules`,
`packages/types`, the list of Cloud Functions in `functions/src/index.ts`, the matching/optimization query sites,
`docs/architecture.md` and `docs/security.md` headings, and notes kept from earlier module work. I did **not** re-run the
test suites, start the emulators or launch the apps for this audit. Anything marked _(from notes)_ was true when it was
recorded (September 2026) and has not been re-verified. A full re-run belongs at the start of Product A's first module.

## 1. What the project is

RideMesh is a ride-sharing optimization platform: passengers request trips, drivers declare journeys, and an
optimization engine groups passengers into shared routes. It is a single global network. It is not a company-scoped
carpooling product.

| Area | What exists |
| --- | --- |
| Monorepo | npm workspaces: `apps/passenger`, `apps/driver` (Expo / React Native), `apps/admin` (Next.js), `packages/{config,firebase,map,maps,mobile-auth,types,ui}`, `functions` (Cloud Functions), `services/optimization` (Python, OR-Tools) |
| Auth and roles | Firebase Auth with email verification. Role is a server-set custom claim (`PASSENGER`, `DRIVER`, `SUPPORT`, `OPERATIONS`, `ADMIN`, `SUPER_ADMIN`). Staff roles are never self-service (`scripts/set-staff-role.mjs`) |
| Data | Firestore: `users`, `drivers`, `vehicles`, `driverJourneys`, `tripRequests`, `journeyPlans`, `notifications`, `driverEarnings`, `receipts`, `config`, `auditLogs` and others behind functions. Default rule is deny |
| Rides | trip request, matching (batch every 2 min plus on-create), route insertion, delay re-optimization, trip execution (`headToPickup` ... `completeDropoff`) |
| Payments | Stripe authorization/capture/void/refund, inbound Stripe webhook, driver earnings, receipts |
| Notifications | in-app plus Expo push |
| Admin console | staff sign-in, drivers/vehicles review, passengers, trips, live map, optimization monitoring, payments, disputes, audit logs, analytics |
| Compliance | data export and account deletion, retention sweeps, audit trail, App Check |
| Docs | README, `docs/architecture.md`, `docs/security.md`, `docs/production-deployment.md`, and others |

## 2. What is missing relative to the two products

Confirmed by searching `apps`, `packages`, `functions/src` and `services`:

| Needed | Present? |
| --- | --- |
| Company / tenant / organization concept | **No.** No company entity, no `companyId` anywhere |
| Employee invitation or company-scoped access | **No** |
| Company admin role | **No.** Only platform staff roles exist |
| Voice (text-to-speech, speech recognition, menus) | **No code at all** |
| Public REST API, API keys, OAuth provider | **No** (only Firebase callables and one inbound Stripe webhook) |
| Outbound webhooks, retry/delivery logs | **No** |
| Connector/adapter layer, developer dashboard | **No** |

## 3. Reusable as-is

- Matching and optimization (`matching.ts`, `optimizationRun.ts`, `planInsertion.ts`, `services/optimization`).
- Trip lifecycle and execution, route/ETA/geocoding, GPS handling.
- Auth, role claims, registration, audit logging, notifications and push.
- `packages/types` (zod schemas shared by client and server), `packages/firebase`, `packages/mobile-auth` (login/home screens), `packages/ui`.
- Admin console shell (Next.js + Tailwind) as a pattern for new web apps.
- The test setup: unit (vitest), integration against emulators, Playwright e2e.

## 4. Needs improvement or is a risk

1. **No tenant isolation.** The matching candidate queries select drivers/requests globally:
   `functions/src/matching.ts:134`, `optimizationRun.ts:172` (SEARCHING requests), `optimizationRun.ts:221` (AVAILABLE journeys),
   `planInsertion.ts:131`. A corporate product must never match across companies, so these need a tenant filter. This is the
   central change for Product A.
2. **One role per user.** An employee may drive on some days and ride on others, but a user has exactly one `role` claim
   (`PASSENGER` or `DRIVER`). See open question Q1 in the requirements doc.
3. **Driver verification is done by platform staff** (`reviewDriver`/`reviewVehicle`, ADMIN/SUPER_ADMIN only). Whether a company
   admin should verify its own employee-drivers is undecided.
4. **Privacy rules are strict by design.** `tripRequests` is readable only by the passenger and the matched driver. Not even
   staff. A company dashboard must therefore use aggregates or audited functions, never a blanket read rule.
5. **Stale documentation.** `docs/architecture.md` says "What exists now (through Module 4.7)" although the code is far beyond
   that. Comments in `firestore.rules` say no earnings/receipts screen exists yet. Both should be refreshed.
6. **Known open items _(from notes, unverified)_:** a cursor millisecond-truncation issue in trip history pagination; integration
   test flakes tied to real OR-Tools timing and cold imports; payment-failed and safety notifications intentionally not built;
   no card-update/retry UI; payments never exercised against live Stripe.
7. **Deployment:** never deployed. The production runbook exists and is intentionally not executed. Per your decision it stays
   paused until both products are built and tested.
8. **Working tree:** on the `docs/readme-final-status` branch there are uncommitted edits to the spec file,
   `apps/admin/.env.example`, `apps/admin/package.json` and `package-lock.json`. They are untouched by this work.

## 5. Bug report

No new bugs were found, because no code was executed in this audit. The bug report required by the master prompt will be
created as `docs/bug-report.md` when testing starts, in the format you specified (title, steps, expected, actual,
priority, fix status). Known items in section 4 point 6 will be carried into it after being reproduced.

## 6. Unverified assumptions to check at the start of Product A

- Test suites still pass on current `develop` (unit and integration).
- The Expo apps still build with the pinned SDK.
- Free on-device speech recognition options work with the Expo SDK in use (see the architecture doc, voice section).
