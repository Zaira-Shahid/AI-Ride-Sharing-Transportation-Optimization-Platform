# A2 design note: company onboarding

Status: draft for review. Nothing in this note is built. It builds on `docs/a1-tenancy-design.md` (data model, claims, rules) and
the A1 code on `feature/a1-tenancy-foundation`.

## 1. Proposed split: A2a, A2b, A2c

Reading the existing code turned up enough work that one module would be too large to review. Proposed:

| Module  | Content                                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| **A2a** | Create a company, invite employees, accept an invitation, list and remove employees, change an employee's role |
| **A2b** | The driving capability: apply to drive, save a vehicle, company-admin review, revoke                           |
| **A2c** | Employee data rights: export my data and delete my account (a gap found while reading the code, section 5)     |

This note designs A2a in full. A2b and A2c are outlined so the decisions that affect A2a are visible now; each gets its own short
note before it is built.

## 2. A2a: functions

All are callables. Each validates its input with a zod schema (mirrored from `@ridemesh/tenancy`, as for other functions), checks the
caller from the signed token, rate-limits with the existing `enforceCallRateLimit`, and writes an audit entry in the same transaction
as the change.

| Function                                     | Who may call                           | What it does                                                                                     |
| -------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `createCompany({ name, ownerName, phone? })` | verified email, no role, no company    | Creates the company, the caller's admin membership and `users` profile, then sets claims         |
| `inviteEmployee({ email, companyRole? })`    | company admin                          | Creates a PENDING invitation and returns the invitation code once                                |
| `listInvitations({ cursor? })`               | company admin                          | Pending and recent invitations of the company (never the code or hash)                           |
| `revokeInvitation({ invitationId })`         | company admin                          | PENDING becomes REVOKED. "Resend" is revoke plus a new invite, because a code is shown only once |
| `acceptInvitation({ code, name, phone? })`   | verified email matching the invitation | Creates profile and membership, marks the invitation ACCEPTED, sets claims                       |
| `listEmployees({ cursor? })`                 | company admin                          | Members of the company (name, email, role, status), paginated                                    |
| `removeEmployee({ uid })`                    | company admin                          | Membership REMOVED, claims cleared, tokens revoked                                               |
| `setEmployeeRole({ uid, companyRole })`      | company admin                          | Promote or demote within the company                                                             |

## 3. A2a: how each part works

### Company creation

- Anyone with a verified email and no role may create a company (Q4: no platform approval). An account that already has any role
  (consumer or staff) or a company is refused, using the same check as `setCompanyClaims` from A1.
- One transaction creates `companies/{id}`, `companies/{id}/members/{uid}` (`COMPANY_ADMIN`, active, `canDrive: false`), and
  `users/{uid}` (`role: EMPLOYEE`, `companyId`, name, email, status `ACTIVE`), plus the audit entry. Claims are set after the
  commit, as `registerUser` does. The call is safe to repeat: if the profile already exists for the same company it only repairs the
  claims.
- Abuse limit: 3 company creations per account per day, and a platform-wide daily cap (configurable) so a script cannot fill the
  database. Because there is no approval step, this cap is the main protection.
- Company settings beyond the name (work sites, commute window) are collected in A4 with the dashboard, since sites need a place search.

### Invitations and the code

- `inviteEmployee` generates 32 random bytes, stores only their SHA-256 hash in `companyInvitations`, and returns the code
  `"<invitationId>.<token>"` **once**. The admin shares it themselves (v1 decision: no email service, no paid provider). The app turns
  it into a link in A4 and A5, using a configurable base URL.
- Lookup is by invitation id (no query by hash). The hash is compared in constant time (`crypto.timingSafeEqual`).
- The email is trimmed and lower-cased. One PENDING invitation per company and email; a second invite for the same email is refused
  until the first is revoked or used. At most 200 PENDING invitations per company. Admin invite rate limit: 30 per hour.
- An invitation expires after 7 days. Expiry is checked when the code is used (and reported as expired). No background job is needed
  in A2a.
- An admin can invite another `COMPANY_ADMIN` by choosing the role.

### Accepting an invitation

1. The person signs up or in with the invited email and verifies it (this happens in the employee app, A5).
2. `acceptInvitation` checks: invitation PENDING and not expired, hash matches, token email verified and equal to the invitation
   email, and the account has no role.
3. One transaction creates the `users` profile and the membership, marks the invitation ACCEPTED (recording the uid), and writes
   the audit entry. Claims are set after the commit. The client then refreshes its token.
4. Repeating the call with the same account after a partial failure repairs the claims (the invitation is already ACCEPTED by that
   uid), so no one is stranded.

### Consumer accounts (decision needed, section 6, question 1)

You decided an invitation is refused when the email already has a consumer account. The question is when to refuse. Checking at
invite time tells the company admin whether an email has a RideMesh account, which leaks account existence to a third party. I
recommend refusing at **accept** time: the person who sees the refusal is the account owner, so nothing leaks, and the refusal
is still guaranteed by `setCompanyClaims` and the role check. The admin sees only "invitation not accepted yet".

### Removing and demoting

- `removeEmployee` sets the membership `REMOVED` (kept, so past rides still count in aggregates as counts only, as you decided),
  clears the claims and revokes tokens (A1's `clearCompanyClaims`), and sets the `users` profile `SUSPENDED` with a reason.
  An admin cannot remove or demote the **last active admin** of a company; this is checked inside the transaction.
- In A2a no company rides exist yet, so there is nothing to release. A3 extends removal to take a driver offline and release
  matched riders, using the existing `releaseMatchedTrips` helper.
- A removed person's invitation or code cannot be reused. Re-inviting the same email creates a new membership later.

### Errors and privacy

Refusals use plain messages that do not reveal other companies or accounts ("This invitation is not valid or has expired" for
wrong, expired, revoked and used codes alike). Codes and hashes never appear in logs or audit entries; audit entries name the
invitation id and the invited email.

### Data written and audit actions

New audit actions (added to `packages/types/src/auditLogs.ts` and the functions mirror, with the existing parity test):
`COMPANY_CREATED`, `EMPLOYEE_INVITED`, `INVITATION_REVOKED`, `INVITATION_ACCEPTED`, `EMPLOYEE_REMOVED`, `EMPLOYEE_ROLE_CHANGED`.
`users/{uid}` gains an optional `companyId` field in the shared type. Consumer profiles do not get the field.

## 4. A2b outline: the driving capability

Reading `verification.ts` and `vehicles.ts` shows the review code works on one document per transaction (driver, then vehicle), so
my A1 note's "one transaction writes `canDrive` and both verification fields" cannot reuse it as it stands. The invariant
still holds if the order is chosen correctly, because it only forbids `canDrive: true` without both verified:

- **Grant:** verify the driver, verify the vehicle (reusing `reviewVerification` for each), then in a final transaction re-read both
  statuses and set `canDrive: true` only if both are still `VERIFIED`. If platform staff rejected one in between, `canDrive` stays
  false.
- **Revoke:** set `canDrive: false` first, then reject the driver and vehicle (reusing `reviewVerification`, which already takes the
  driver offline and releases matched riders). `canDrive: false` with a verified driver is a legal state.
- A company admin can only act on an **active member of their own company** (checked from the membership document, not the token).
- Order of use for an employee: apply to drive (creates their `drivers/{uid}`), save a vehicle (a company wrapper over the existing
  `saveVehicle` logic, gated on an active membership, not on `canDrive`), then wait for review.

## 5. A2c: a gap found in data rights

`exportMyData` and `deleteMyAccount` route drivers to the driver handlers and **everyone else to the passenger handlers, which
refuse anyone who is not a verified passenger**. An employee would be refused both, so employees could not export or delete their
data. That must be fixed before any real use. Proposed A2c: an employee handler for both (export profile and membership and own
rides; deletion removes the profile and Auth user, anonymises the membership, keeps ride counts), reusing the existing patterns.

## 6. Questions for review

1. **Consumer-account refusal at accept time** (section 3) rather than invite time, to avoid leaking whether an email has an account.
   Is that acceptable?
2. **Split into A2a, A2b and A2c** (section 1). Agreed?
3. **Company creation abuse cap:** 3 per account per day and a configurable platform-wide daily limit, with no approval step. Is
   that enough protection for v1, or do you want a platform-staff approval switch available even if off by default?
4. **Invitation code format:** one string, `"<invitationId>.<token>"`, shared as text or a link. OK for v1?
5. **Removal:** keep the membership as `REMOVED` and suspend the `users` profile rather than deleting anything. OK?

## 7. Test plan (A2a)

Emulator integration tests: create company (success, refused for consumer, staff, existing member, unverified email, repeat call
repairs claims, rate and platform caps); invite (admin only, duplicate email, pending cap, rate limit, role choice); accept (valid,
wrong code, expired, revoked, already used, email mismatch, unverified email, existing role refused, partial-failure repair); list
employees and invitations (admin only, never another company, never the code or hash); remove and demote (last-admin guard,
claims cleared and tokens revoked, repeated call safe). Unit tests for the schemas and code format; parity tests for mirrored
constants. After the module, the full regression gate against `docs/baseline-a0.md`.
