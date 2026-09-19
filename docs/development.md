# Development guide

## Requirements

- Node.js 22 or newer and npm 10 or newer
- Firebase CLI (`npm i -g firebase-tools`), logged in with `firebase login`
- Java 21 or newer, only for the Firestore emulator

## Commands

| Command                                                | Purpose                                                |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `npm run verify`                                       | Format check, lint, type check and tests               |
| `npm run lint` / `npm run lint:fix`                    | ESLint                                                 |
| `npm run format` / `npm run format:check`              | Prettier                                               |
| `npm run typecheck`                                    | `tsc --noEmit` in every workspace and at root          |
| `npm test`                                             | Vitest                                                 |
| `npm run dev:admin`                                    | Admin dashboard on port 3000                           |
| `npm run dev:passenger` / `dev:driver`                 | Expo dev servers                                       |
| `npm run build:functions`                              | Compile Cloud Functions to `functions/lib`             |
| `npm run emulators`                                    | Build functions and start Firebase emulators           |
| `npm run verify:firebase`                              | Live check against the real Firebase project           |
| `npm run test:integration`                             | Emulator tests: rules, functions, admin script         |
| `npm run test:e2e`                                     | Playwright: real app UI against the emulators          |
| `npm run web --workspace @ridemesh/passenger`          | Run an app in the browser for development (driver too) |
| `npm run admin:set-staff-role -- <email> <ROLE>`       | Assign a staff role (see docs/security.md)             |
| `npm run export:check --workspace @ridemesh/passenger` | Verify the Android bundle compiles (also driver)       |

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

End-to-end tests in `tests/e2e` use Playwright with Chromium (`npx playwright install chromium`
once). `npm run test:e2e` starts the emulators and both Expo web builds with fake demo-project
configuration, so it needs no real credentials, and drives the real registration screens.

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
