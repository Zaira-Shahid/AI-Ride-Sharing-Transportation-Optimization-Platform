# A1 design note: tenancy foundation

Status: draft for review. Nothing in this note is built. Read it with `docs/product-architecture.md` (sections 2 and 3) and
`docs/product-a-corporate-requirements.md` (Q1, Q2, Q3, Q5).

## 1. What A1 delivers, and what it does not

**A1 delivers** the foundation only: shared types, the new collections, the identity (claims) model, Firestore rules, and rules
and parity tests. It adds no screens and no user-facing function.

| In A1                                                                        | Moves to a later module                                                      |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/tenancy` (types and zod schemas, pure TypeScript)                  | Company creation, invitations, accept flow (A2)                              |
| `companies`, `companies/{id}/members`, `companyInvitations` data model       | Stamping `companyId` on requests and journeys, tenant-filtered matching (A3) |
| Claims model and a server helper that sets and clears them                   | "Acting as driver or rider" for existing callables (A3 and A5)               |
| New role value `EMPLOYEE` in the shared role enum, with no self-service path | Company-scoped driver review (A2, with the data it needs defined here)       |
| Firestore rules for the new collections, plus rules tests                    | Free-ride payment skip (A3)                                                  |
| Regression run proving consumer behaviour is unchanged                       | Dashboard, voice, employee app                                               |

## 2. Identity: what goes in the token

Decision from review (Q1): the claim carries company ID and role only. The driving capability is **not** in the token. It is read
from the membership document on the server.

Interpretation to confirm: today a user has one platform `role` claim, and every existing function and rule checks it
(`requireVerifiedDriver` needs `DRIVER`, `requireVerifiedPassenger` needs `PASSENGER`, and the rules use `role()` the same way).
An employee is neither, so I propose these claims, all set only by server code:

| Claim         | Values                        | Purpose                                                                                                      |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `role`        | `EMPLOYEE` (new value)        | Marks a company member. Consumer sign-in already refuses any other role (`sign-in.ts`), so isolation is free |
| `companyId`   | the company's document ID     | Tenant boundary used by rules and the tenant stamp                                                           |
| `companyRole` | `COMPANY_ADMIN` or `EMPLOYEE` | What the person may do inside the company                                                                    |

That is company ID and role as you asked, plus the platform `role: EMPLOYEE` marker the existing code needs in order to tell
employees apart from consumers. A company admin is also `role: EMPLOYEE` with `companyRole: COMPANY_ADMIN`, so an admin who also
commutes needs no second account.

Why not keep `role: PASSENGER`: a company member could then sign in to the consumer passenger app, and the consumer app would treat
them as an ordinary rider. A distinct role keeps the two worlds apart without changing any consumer code.

**Token staleness.** Claims refresh at most hourly. Removing an employee therefore sets their membership to `REMOVED`, rewrites
the claims and revokes refresh tokens, but a token already issued can live up to an hour. So:

- Anything sensitive goes through a callable that reads the membership document (authoritative, never stale).
- Rules that trust the claim guard only low-sensitivity data (the company's own name and settings).

## 3. Data model

```
companies/{companyId}
  name, status (ACTIVE | SUSPENDED), sites[], settings{...}, createdBy, createdAt, updatedAt

companies/{companyId}/members/{uid}
  companyRole        COMPANY_ADMIN | EMPLOYEE
  status             ACTIVE | REMOVED
  canDrive           boolean          the driving capability (Q1)
  driverReviewedBy   uid | null       the company admin who approved (Q5)
  driverReviewedAt   timestamp | null
  joinedAt, updatedAt

companyInvitations/{inviteId}
  companyId, email (lower-cased), tokenHash, companyRole, status (PENDING | ACCEPTED | REVOKED | EXPIRED),
  expiresAt, createdBy, createdAt
  (the plain token is emailed once and never stored)

users/{uid}.companyId        nullable; null for every consumer, so existing documents stay valid
```

`members` is a subcollection of the company, so "all members of company X" is one cheap query and a rule can scope on the path.

### The driving capability (`canDrive`)

- `canDrive` is a permission set by the company admin (Q5) in the same transaction that writes the existing driver and vehicle
  verification fields on that employee's `drivers/{uid}` and `vehicles/{uid}` documents. The matching engine already decides who may
  go online from those fields (`availability.ts`), so **the engine needs no change**, and a company driver is held to the same
  vehicle and seat checks as any driver.
- One writer only: a single company-scoped review function writes `canDrive` and the verification fields together. A test asserts
  they cannot disagree (`canDrive` true only if driver and vehicle are `VERIFIED`).
- Revoking the capability, or removing the employee, sets `canDrive` false and sets any open journey offline, using the existing
  helper that releases matched trips back to searching.
- Reading it costs one membership read on session-start actions (go online, declare a destination), not on every GPS update. The
  location-update path keeps relying on the journey that go-online already authorised.

### Rider and driver at once

An employee may drive some days and ride others. They must not do both at the same time, because the existing model keeps one open
request (`users.currentTripRequestId`) and one open journey (`drivers.currentJourneyId`) independently. Proposed invariant, enforced
server-side in A3 and tested: an employee with an open trip request cannot go online as a driver, and the reverse.

## 4. Firestore rules (A1)

All new collections default to deny. Writes are always server-only, as for every other collection here.

| Path                           | Read allowed to                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `companies/{id}`               | a verified user whose `companyId` claim equals `{id}`; platform staff                         |
| `companies/{id}/members/{uid}` | the member themselves (their own document); a `COMPANY_ADMIN` of `{id}`; platform staff       |
| `companyInvitations/{id}`      | nobody from a client (the invitation flow is entirely callables); platform staff only to list |

Existing rules gain a small change so employees can read their own documents: `driverJourneys` and `tripRequests` reads currently
require `role() == 'DRIVER'` or `'PASSENGER'`. They will also accept `'EMPLOYEE'`, still tied to ownership by uid
(`driverId` or `passengerId`), so no cross-tenant read is opened. This edit is made in A3 when employees first own such documents, not in A1.

## 5. What cannot go wrong in A1, and how it is checked

1. **Consumer behaviour unchanged.** Adding `EMPLOYEE` to the role enum must not change any consumer path. `SELF_SERVICE_ROLES`
   stays `PASSENGER` and `DRIVER`, so `completeRegistration` still refuses anything else. Checked by the existing suites (the
   regression gate) and by new parity tests.
2. **Parity.** `tests/roles-parity.test.ts` already compares the functions' role handling with the shared package. It is extended for
   the new role and for the new schemas (`functions` does not import workspace packages, so schemas are mirrored and tested).
3. **Rules tests** (emulator): a member reads their own company and their own membership, not another company's; a company admin of
   company A cannot read company B; an employee cannot read the member list; a consumer reads nothing; clients cannot write any new
   collection; an invitation is unreadable from a client.
4. **Claims helper tests:** setting, replacing and clearing company claims preserves unrelated existing claims (the existing helpers
   spread `customClaims`, so this must keep working) and revokes refresh tokens on removal.
5. **Regression gate:** unit and integration suites after A1, against the baseline in `docs/baseline-a0.md`.

## 6. Risks and mitigations

| Risk                                                                                   | Mitigation                                                                                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A new enum value breaks an exhaustive `switch` or `z.enum` somewhere                   | Typecheck plus grep for role handling in A1; the regression suites                           |
| Company admins verifying their own drivers is weaker vetting than platform review (Q5) | Company drivers match only with colleagues, never consumers (A3); a platform suspend remains |
| Stale claims after removal                                                             | Sensitive paths read the membership document; refresh tokens revoked (section 2)             |
| `canDrive` and the driver verification fields drift apart                              | Single writer function plus an invariant test                                                |
| Index and rule growth                                                                  | New indexes added with the module that needs them, checked by the integration run            |

## 7. Questions for review

1. Is the three-claim shape in section 2 acceptable (`role: EMPLOYEE`, `companyId`, `companyRole`)? It adds the platform `role`
   marker to your "company ID and role only" wording, because the existing code requires one.
2. **Existing consumer accounts:** if an invited email already belongs to a consumer account, I propose refusing the invitation with a
   clear message in v1 (one account is either a consumer or a company member). The alternative is converting the account, which has
   data and payment implications. Which do you prefer?
3. May the company admin also be an employee who commutes (as proposed), or should admin accounts be management-only?
4. Should a removed employee's past rides stay visible to the company in aggregate counts? I propose yes, as counts only.
