# A4 design note: the company dashboard (`apps/corporate`)

Status: draft for review. Nothing in this note is built. It follows the module plan in `docs/product-architecture.md` (section 8) and uses
everything A1 to A3b built: companies and members (A1), invitations and employee management (A2a), driver applications (A2b),
employee data rights (A2c), company-only matching (A3a) and the decline window (A3b).

## 1. What A4 delivers

A web console for **company administrators**, in a new app `apps/corporate`. It is the first thing a company sees: it creates
the company, invites people, approves drivers, and sets the one company setting that exists so far. It reuses the stack of the
existing admin console (Next.js, Tailwind, the same design tokens) and the same Firebase project and functions.

It does **not** show rides, places or statistics. The dashboard figures (activity, occupancy, shared rides) are module A7, built on
aggregates, so this console stays consistent with the rule that a company administrator never sees where anyone travels.

| In A4                                                                                     | Not in A4                                                      |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Sign up, verify email, create the company; sign in and out                                | Activity and ride statistics (A7)                              |
| An overview with counts only                                                              | Work sites with place search, voice defaults (see question 4)  |
| Employees: list, promote and demote, remove                                               | The employee mobile app (A5)                                   |
| Invitations: create (the code is shown once), list, revoke                                | Voice (A6)                                                     |
| Driver applications: review, approve, reject with a reason, and revoke an approved driver | Sending email (v1 decision: the administrator shares the code) |
| Settings: company name and the driver decline window (0 to 30 minutes)                    |                                                                |

## 2. Backend additions this needs

A4 is not only screens. Two small callables are missing, plus client wrappers:

| Function                                                        | Why                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `updateCompanySettings({ name?, driverDeclineWindowMinutes? })` | A3b reads the window from `companies/{id}.settings`; nothing writes it yet. Administrator only, validated (name 2 to 100, window a whole number 0 to 30), audited (`COMPANY_SETTINGS_CHANGED`), rate limited        |
| `getCompanyOverview()`                                          | Counts only, from cheap count queries: active employees, pending invitations, applications waiting for review, approved drivers. Loading whole lists to count them would be wasteful and, for a large company, slow |

`packages/firebase` gains a `company.ts` with one wrapper per company callable (the A2a and A2b ones too), each translating errors
into the same plain messages the other wrappers give. The company document itself is read directly: the existing rule lets any member
read their own company. Request and result types already exist in `@ridemesh/tenancy`.

## 3. Screens

One sidebar (a drawer on a phone, as the admin console does) with: Overview, Employees, Invitations, Driver applications, Settings.

| Screen              | Route                  | Purpose and controls                                                                                                                                                       | Empty, error and success                                                                                                                                        |
| ------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in             | `/sign-in`             | Email and password; link to sign up and to password reset (the existing reset flow)                                                                                        | Field errors; a plain refusal for a consumer, an ordinary employee or platform staff: "This account cannot use the company console"                             |
| Sign up             | `/sign-up`             | Name, email, password; creates the account and sends the verification email                                                                                                | Field errors; resumes if the account half-exists                                                                                                                |
| Verify email        | `/verify-email`        | Explains the link was sent; "Send again", "I have verified" (reloads the account)                                                                                          | Resend confirmation and error; moves on by itself once verified                                                                                                 |
| Create company      | `/create-company`      | Company name, your name, phone (optional). Shown to a verified account that has no company yet                                                                             | Server refusals ("already has a role"), the daily limit message; success refreshes the token and opens Overview                                                 |
| Overview            | `/`                    | Four count tiles (each links to its screen), a short "Get started" checklist that disappears when done, the company name                                                   | Zero counts show as such, with what to do next                                                                                                                  |
| Employees           | `/employees`           | Table of name, email, role, status, driver status; "Make administrator" / "Make employee", "Remove", "Revoke driving" for an approved driver; Load more                    | Empty state links to Invitations. Confirmation dialogs for remove and revoke (revoke asks for a reason). The last-administrator refusal is shown in plain words |
| Invitations         | `/invitations`         | Email and role; on success a one-time panel with the code, a Copy button, and ready-to-paste message text; the table of invitations with status; "Revoke" on pending ones  | The panel says the code will not be shown again. Duplicate, cap and rate-limit refusals are explained                                                           |
| Driver applications | `/driver-applications` | Cards: the employee, vehicle (type, make, model, plate, seats), driver and vehicle status, what is waiting. "Approve", "Reject driver", "Reject vehicle" (reason required) | Empty state "Nobody is waiting". Your own row is shown but approving it is disabled with the reason (another administrator must)                                |
| Settings            | `/settings`            | Company name; decline window (0 to 30 minutes, with a sentence saying what 0 and silence mean)                                                                             | Save button disabled until changed; inline validation; success message                                                                                          |

Every screen has a loading state, an error state with a retry, and no control that does nothing. Dangerous actions (remove, revoke, reject)
use a confirmation dialog that names the person. Nothing here shows a trip, a place or a location.

**Guard.** The console decides who sees it from the signed token, using `parseCompanyClaims` and `isCompanyAdmin` from `@ridemesh/tenancy`.
That is only for what to draw: every function still checks the membership document on the server, so a stale token can never do more than
the server allows. After creating a company or any change to the signed-in person's own claims, the app refreshes the token.

## 4. What is reused, and one decision

| Reused as-is                                                    | From                                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Design tokens (colours, radii) and the Tailwind setup           | \`packages/ui/src/tokens.css\`, \`apps/admin/postcss.config.mjs\`, \`app/globals.css\`          |
| Firebase client factory, emulator options, the test port offset | \`apps/admin/lib/firebase.ts\`, \`@ridemesh/firebase\`, \`@ridemesh/config\`                    |
| The auth provider and hook                                      | \`@ridemesh/firebase/react\` (\`AuthProvider\`, \`useAuth\`)                                    |
| Account creation, verification email, password reset            | \`registerAccount\`-style code in \`packages/firebase/src/register.ts\`, \`password-reset.ts\`  |
| The "incomplete" session state                                  | \`deriveSessionStatus\`: a verified account with no role is exactly "needs to create a company" |
| Claims, results and input types                                 | \`@ridemesh/tenancy\`                                                                           |

**The decision.** The shell pieces I want (sidebar with a mobile drawer, page header, empty state, "Load more" and the paging hook, the
form styling) live **inside `apps/admin`**, not in a shared package, and are tied to its name and navigation. Two ways to use them:

- **Copy and adapt about six small files into `apps/corporate`** (recommended). No risk to the admin console, which has its own
  end-to-end tests. The cost is some duplication, which I would remove later by extracting a shared package once both apps are stable.
- **Extract a `packages/web-ui` now and change the admin console to use it.** Cleaner, but it edits a working staff console in the
  middle of a different module.

The company sign-up and verification pieces are written fresh as web forms, since the existing ones are React Native screens.

I would not change the shared `AuthProvider`. The console reads `companyId` and `companyRole` from the token in its own small hook, so
the consumer apps are untouched.

## 5. How it will be tested

| Layer                        | What                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                         | The console's own logic as plain functions: who may enter (every claim combination), form validation, the messages for each server refusal, the share text for an invitation. The repository has no component test setup, and I do not propose adding one |
| Integration (emulators)      | `updateCompanySettings` and `getCompanyOverview`: who may call, validation, audit entries, counts are right and never another company's, the window setting changes the next match's deadline (ties to A3b). Plus the client wrappers                     |
| Browser end-to-end           | The company journey, below, with Playwright against the real console, emulators and functions                                                                                                                                                             |
| Responsive and accessibility | The key screens at phone and desktop widths; keyboard-only completion of a form; every control reachable by its accessible name                                                                                                                           |
| Regression gate              | Unit, typecheck, lint, format, the full integration suite (optimizer files from Docker), and the existing admin end-to-end specs, as for every module                                                                                                     |

**The browser end-to-end test: the company journey.** A new spec in `tests/e2e`, in a desktop browser, with the console on its own test port
(the usual ports plus 10000, like the others), served by Next with its own build folder so it never collides with a developer's server:

1. Sign up in the browser; read the verification link from the Auth emulator (as the existing specs do) and verify; create the company.
2. Invite two employees from the Invitations screen; capture each code from the one-time panel and check it is not shown again after reload.
3. Each employee accepts through the real function (the employee app does not exist until A5), and appears in Employees with the right role.
4. One employee applies to drive and adds a vehicle (through the real functions); the application appears; the administrator approves it in the UI;
   the employee shows as an approved driver. Rejecting needs a reason. Approving your own application is disabled with an explanation.
5. Change the decline window in Settings and confirm it saved (and, through the function, that the next match uses it).
6. Promote the second employee to administrator; remove the first (a confirmation names them); try to remove or demote the last administrator and see the plain refusal.
7. Sign out and in; the verify and create-company screens appear for the right account states.
8. Refusals in the browser: an ordinary employee, a consumer passenger, a consumer driver and a platform staff account are each turned away at sign-in with the plain message.

A second, shorter pass runs the main screens at a **phone width (390 px)**: the drawer opens and closes, tables do not scroll the page sideways, and a
one-time code can be copied. Screenshots of the key screens are kept as test artefacts, not committed.

**Playwright configuration.** The shared config gets one more web server for the console. Every end-to-end run then starts it too, which adds start-up time to the
whole suite. The existing specs are not edited; I will run the admin ones with the new spec as part of the gate, and the **full suite once at the end of A4** (176 tests;
it has not been part of the gate before) and report it.

## 6. Splitting A4

The module is large enough to review in two parts:

| Module  | Content                                                                                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A4a** | The two backend functions and wrappers; the app skeleton and shell; sign up, verify, create company, sign in and out, the guard, Overview; the onboarding half of the browser test |
| **A4b** | Employees, Invitations, Driver applications and Settings; the full company-journey browser test; the responsive pass                                                               |

## 7. Risks

| Risk                                                                                       | Mitigation                                                                                         |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| The new Playwright web server slows or destabilises the shared suite                       | Own build folder and port; run the existing admin specs and, at the end, the full suite            |
| Claims lag: after creating a company or being promoted, the old token still says otherwise | Refresh the token after the actions that change it; the server never trusts the token alone anyway |
| Duplicated shell code drifts from the admin console's                                      | Small, documented, and a follow-up to extract once both apps settle                                |
| An invitation code is lost                                                                 | The panel says it appears once; "Revoke and invite again" is one click                             |
| The browser test depends on the emulator's verification link                               | The existing specs already read it from the Auth emulator's own endpoint                           |

## 8. Questions for review

1. **What is the console called?** `APP_DISPLAY_NAMES` has passenger, driver and admin names. I will use "RideMesh Company" as a placeholder unless you give me one.
2. **Copy and adapt the shell pieces into `apps/corporate`** (recommended), or extract a shared package now and touch the admin console?
3. **Split into A4a and A4b** (section 6)?
4. **Work sites (with place search) and voice defaults are left out of A4.** Sites need the place-search work, and voice defaults only mean something once voice exists (A6). Agreed?
5. **Overview shows counts only**, with the activity figures in A7. Agreed?
6. **Dark theme only for now**, matching the admin console and the existing tokens; a light theme is a later change. Agreed?
7. **Accessibility checks:** the role-and-name locators and a keyboard-only test need nothing new. An automatic accessibility scan (`@axe-core/playwright`) would add a dev dependency. Add it, or keep to the manual checks?
8. **Run the full Playwright suite once at the end of A4** and report it, since the shared configuration changes?
