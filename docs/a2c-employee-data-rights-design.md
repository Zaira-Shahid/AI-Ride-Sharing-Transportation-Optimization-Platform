# A2c design note: employee data rights

Status: draft for review. Nothing in this note is built. It closes the gap named in `docs/a2-company-onboarding-design.md`
(section 5) and follows the patterns of the passenger and driver versions, `functions/src/dataRights.ts` and
`functions/src/driverDataRights.ts`. It must land before any real use of the corporate product.

## 1. The gap, and a second one found while designing

`exportMyData` and `deleteMyAccount` serve drivers through the driver handlers and **everyone else through the passenger
handlers, which refuse anyone who is not a verified passenger**. An employee is neither, so an employee can do neither.

A second gap sits behind it. When an employee is removed from a company, their claims are cleared (A2a), so their token
carries **no role at all**. Routing by the token's role would send them to the passenger handlers and refuse them as well, so a
person who has left the company would be unable to download or delete their own data. That is the moment such a right matters most.

## 2. What A2c delivers

| Function (existing names, routed by who the caller is) | Who may call                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| `exportMyData`                                         | a verified email whose profile is an employee, active or removed |
| `deleteMyAccount({ confirm: 'DELETE' })`               | the same                                                         |

The callables keep their names, so the client wrappers and the shared privacy screen are unchanged, as they already are for
drivers. New handlers live in `functions/src/employeeDataRights.ts` and reuse the shared helpers in `dataRights.ts` (the record
cap, the chunked delete, the field readers and the deletion log).

**Routing.** `index.ts` already picks by role. It gains one branch: a token role of `EMPLOYEE`, **or** no role in the token but a
`users/{uid}` profile whose role is `EMPLOYEE` (a removed employee), goes to the employee handlers. The profile check only ever
exposes the caller's own data, requires a verified email, and cannot be reached by a consumer, whose token keeps its role.

## 3. Export

An explicit allow-list of what the person gave or generated, never a raw dump, capped per kind with `truncated` when something
was cut off (the same rule as the driver export). Nothing about any other member, the company's other data, or any invitation
written to someone else.

| Section                | Contents                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `profile`              | name, email, phone, account status, when created                                                                                  |
| `company`              | the company's name, the person's role in it (`companyRole`), membership status, when they joined                                  |
| `driving`              | whether they applied, `canDrive`, the driver and vehicle verification statuses and reasons, and the vehicle's own details         |
| `trips` and `journeys` | company rides they took or drove: as a rider their own places and times, as a driver status, times and fare only (as for drivers) |
| `notifications`        | their notices                                                                                                                     |
| `invitation`           | the invitation they accepted: its status and dates (their own email is in `profile` already)                                      |

An `ACCOUNT_DATA_EXPORTED` audit entry is written. Rate limit: 5 an hour, as for the others. Company rides do not exist until
A3, so the ride sections are built now against seeded data and are covered by tests that seed it.

## 4. Deletion

Ordered so a stopped call can be repeated safely (every step tolerates having already happened), as in the driver version.

1. **Refuse** while anything is in flight, with a plain message: an online driver; a journey that is available, matching or
   active; a ride they are on or driving that is not finished (the same `RIDE_IN_FLIGHT` statuses as consumers); an open trip
   request; **or being the last active administrator of a company that still has other active members** (section 5).
2. **Take them out of other people's records**: in any ride they drove, remove the driver's name, vehicle, plate and position
   from the rider's record, keeping the ride itself, as the driver deletion does.
3. **Clear places and links** from their own journeys and requests, keeping the rides as numbers (decided under A2a: past rides
   still count in aggregates, as counts only).
4. **The membership is kept but stripped**: `companies/{id}/members/{uid}` becomes `REMOVED`, `canDrive` false, with only
   non-identifying fields left (role in the company, dates). Its id is the uid, which is exactly the pseudonymous identifier that
   audit entries already keep. The invitation they accepted has the person's **email cleared** (the status and dates stay, as the
   company's record that the code was used).
5. **Delete** their notifications, vehicle, driver profile and user profile.
6. **Delete the sign-in account.** A missing one counts as already done.

There is **no payment step**: company rides are free in v1 (Q2), so no Stripe customer, receipt or earning exists. The code
still anonymizes any receipt or earning it finds, defensively, so a later change to that decision cannot silently leave payment
records behind.

**Kept on purpose**, as for consumers: audit entries (they hold the uid as actor), the per-account rate-limit counters (a uid and
a count), the company's own documents (`createdBy` holds a uid), and invitations the person created for others (the company's
records, naming the invited people).

## 5. The last administrator

A company must not be left without an administrator by someone deleting their account, and must not be silently orphaned.
Proposed rule:

- If the person is the **last active administrator and others are still active members**: refuse with "Make someone else an
  administrator first." (the same guard as A2a's removal).
- If they are the **only active member**: allow it, and the company is set to `SUSPENDED` with the reason "Closed by its last
  member", so it cannot be used or joined but its history is kept for platform staff.

## 6. Name and phone corrections

The existing `users` rule already lets a signed-in person change their own name and phone directly, and nothing else (it lists
the only allowed keys). An employee's profile follows the same rule. A2c adds a rules test proving an employee can edit those two
fields and **cannot** change their role, status or `companyId`, since that is the only correction right that needs no function.

## 7. Tests

Emulator integration tests: export (the allow-list, nothing from another member or company, company and driving sections,
seeded rides with a driver's places absent, the rate limit, the audit entry, a removed employee can export); deletion (each
refusal, including the last-administrator and the in-flight cases; a full deletion leaves no profile, driver, vehicle or
notification, strips the membership, clears the invitation email, deletes the sign-in account, and writes the audit entry; repeating
a stopped deletion; a removed employee can delete; a sole member closes the company); routing (consumers and drivers still reach
their own handlers and an employee cannot reach theirs by claiming a role); and the rules test in section 6. Each guard is
mutation-checked. Then the full regression gate against `docs/baseline-a0.md`.

## 8. Not in A2c

The employee app's privacy screen (A5), and any export or deletion for **a company** as a whole (a company closing is a platform
decision, not a person's data right).

## 9. Questions for review

1. **Removed employees keep these rights**, found by their profile when their token has no role (section 2). Agreed?
2. **The last-administrator rule** in section 5, including closing a company when its only member deletes their account. Agreed?
3. **The stripped membership is kept** under the uid, as audit entries already are, so past rides still count as numbers. Agreed?
4. **An in-flight ride blocks deletion**, as for consumers and drivers. Agreed?
5. **Invitation emails**: the accepted invitation's email is cleared on deletion; invitations an administrator created for others
   stay with the company. Agreed?
