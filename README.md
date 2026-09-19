# RideMesh

RideMesh is an AI-assisted ride-sharing and transportation optimization platform. Rather than
matching one passenger to the nearest driver, it looks for the combination of journeys that moves
the most people with the fewest vehicle trips, while respecting every passenger's stated limits on
walking, extra time and route changes.

The full product and engineering specification is
[AI_Ride_Sharing_Platform_Professional_Spec.md](AI_Ride_Sharing_Platform_Professional_Spec.md). It is
the single source of truth for scope, sequencing and the definition of done.

## Status

Phase 1, Module 1.2 (registration). Phase 0 and the role system are complete. Passengers and
drivers can register and verify their email; sign-in, password reset and product features are not
built yet, and the signed-in screens are still empty states.

## Repository layout

```text
apps/
  passenger/   Expo (React Native) passenger app
  driver/      Expo (React Native) driver app
  admin/       Next.js + Tailwind operations dashboard
functions/     Firebase Cloud Functions (TypeScript)
services/
  optimizer/   Reserved for the Python optimization service
packages/
  config/      Shared tsconfig base and brand constants
  types/       Shared domain types and Zod schemas
  ui/          Design tokens
  firebase/    Firebase client, auth flows and validated configuration
  mobile-auth/ Shared authentication screens for the two mobile apps
docs/          Architecture and development documentation
tests/         Repository-level tests
scripts/       Repository scripts
```

## Getting started

Requirements: Node.js 22 or newer, npm 10 or newer, the Firebase CLI, and Java 21 or newer if you
want to run the Firestore emulator.

```bash
npm install
npm run verify        # format check, lint, type check and tests
```

Run the applications:

```bash
npm run dev:admin       # http://localhost:3000
npm run dev:passenger   # Expo dev server
npm run dev:driver      # Expo dev server
npm run emulators       # Firebase emulators (Auth, Firestore, Functions)
```

Environment variables are documented in [docs/development.md](docs/development.md). Real values live
in local, git-ignored files and are never committed.

## Documentation

- [Architecture](docs/architecture.md)
- [Development guide, Git workflow and conventions](docs/development.md)
- [Roles, access and security](docs/security.md)
