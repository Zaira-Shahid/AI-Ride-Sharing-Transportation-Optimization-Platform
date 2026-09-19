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

## What exists now (Module 0.1)

| Area            | Location                                  | State                                                                                        |
| --------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Passenger app   | `apps/passenger`                          | Expo Router shell with Home, Trips, Wallet, Profile tabs (spec section 49). Empty states.    |
| Driver app      | `apps/driver`                             | Expo Router shell with Home, Current Journey, Earnings, History, Profile tabs. Empty states. |
| Admin dashboard | `apps/admin`                              | Next.js shell with the sidebar sections from spec section 22. Empty states.                  |
| Cloud Functions | `functions`                               | A single `healthCheck` HTTPS function so the build and emulator can be exercised.            |
| Firebase config | `firebase.json`, `.firebaserc`, `*.rules` | Project pinned, emulators configured, Firestore rules deny all client access.                |
| Shared types    | `packages/types`                          | Roles, state enumerations, `Location`, all with Zod schemas.                                 |
| Design tokens   | `packages/ui`                             | Specification palette, semantic light and dark themes, spacing, radius, type, motion.        |
| Firebase client | `packages/firebase`                       | Validates the Firebase web config and initialises the shared Firebase app.                   |
| Optimizer       | `services/optimizer`                      | Placeholder only. Built in Phase 6.                                                          |

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
- `firestore.rules` denies all client reads and writes. Role-based rules arrive with authentication
  (Phase 1). Roles will be verified server-side through custom claims; a client-side role field is
  never trusted.
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
