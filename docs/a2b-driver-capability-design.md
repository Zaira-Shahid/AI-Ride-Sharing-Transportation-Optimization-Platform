# A2b design note: the driving capability

Status: draft for review. Nothing in this note is built. It follows `docs/a1-tenancy-design.md` (section 3, "The driving capability")
and `docs/a2-company-onboarding-design.md` (section 4, the A2b outline), and builds on the A2a code.

## 1. What A2b delivers

An employee can apply to drive, add a vehicle, and be approved or turned down by their **company administrator** (Q5). An
administrator can later revoke the capability. Nothing here lets anyone go online or be matched: the existing driver functions
(`setAvailability`, `declareDestination`, and the rest) refuse an `EMPLOYEE` role today, and A3 adds the company-aware wrappers. So A2b
cannot put an unapproved person on the road by construction.

| Function (all callables)                        | Who may call                       | What it does                                                                                           |
| ----------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `applyToDrive()`                                | active employee                    | Creates the employee's `drivers/{uid}` profile if missing and records `driverRequestedAt`              |
| `saveEmployeeVehicle(input)`                    | active employee who has applied    | The existing `saveVehicle` logic, for an employee                                                      |
| `setEmployeeVehicleCapacity(input)`             | active employee who has applied    | The existing `setVehicleCapacity` logic, for an employee                                               |
| `requestEmployeeDriverReview({ target })`       | active employee                    | The existing `requestReview`: moves a REJECTED driver or vehicle back to PENDING                       |
| `listDriverApplications()`                      | company admin                      | Applicants of the company with driver and vehicle status and the vehicle's make, model, type and plate |
| `approveEmployeeDriver({ uid })`                | company admin (not for themselves) | Verifies the driver and the vehicle, then grants `canDrive`                                            |
| `rejectEmployeeDriver({ uid, target, reason })` | company admin (not for themselves) | Rejects the driver profile or the vehicle with a reason                                                |
| `revokeEmployeeDriver({ uid, reason })`         | company admin (not for themselves) | Withdraws `canDrive` first, then rejects the driver and vehicle                                        |

Employee-side functions work by calling the existing driver code with a caller whose role is `DRIVER`, after the wrapper has
checked from the **membership document** that the person is an active employee of an active company. No new driver logic is
written, so a company driver is held to exactly the same plate, seat and verification rules as any other driver.

## 2. A refinement to the A1 note: effective capability

A1 said `canDrive` is written together with the verification fields in one transaction, and a test would assert they never disagree.
Reading `vehicles.ts` and `verification.ts` shows that cannot hold for the whole lifetime:

- If an employee **edits their vehicle**, `saveVehicle` sends the vehicle back to PENDING by itself.
- If **platform staff** reject the driver or vehicle through the existing admin console, the verification changes with no knowledge of
  `canDrive`.

Making those existing functions company-aware would mean editing code that consumers rely on. Instead I propose a simpler rule:

> `canDrive` is the **administrator's permission**. A person can actually drive only when `canDrive` is true **and** the driver and
> the vehicle are both currently `VERIFIED`. That combined check is the effective capability.

- `canDrive` is written only by approve, revoke and removal. Approval still refuses to set it unless both are `VERIFIED` at that
  moment (the A1 `isDriveCapabilityConsistent` check, kept for writes).
- Later drift is harmless, because every use goes through the combined check (a new `hasEffectiveDriveCapability` in
  `@ridemesh/tenancy`). A stale `canDrive: true` with a PENDING vehicle simply means "not driving until re-verified".
- A3 and A5 call the combined check wherever an employee goes online. The existing consumer code is not touched.

The administrator's list shows a driver whose vehicle changed as "needs review again", so a lapse is visible.

## 3. How approval and revocation stay consistent

The existing review code changes one document per transaction (driver, then vehicle), so approval is a short sequence, ordered so
that every intermediate state is legal:

**Approve** (administrator, never for themselves):

1. Check the target is an active member of the administrator's company and has applied, and that the vehicle exists. Check before
   changing anything, so a missing vehicle does not leave a half-verified driver.
2. Verify the driver, then the vehicle, using the existing `reviewVerification` (it audits each decision).
3. One final transaction re-reads both statuses and, only if both are still `VERIFIED`, sets `canDrive: true`, records
   `driverReviewedBy` and `driverReviewedAt`, clears `driverRequestedAt`, and audits `EMPLOYEE_DRIVER_APPROVED`.

If the employee changes the vehicle between steps 2 and 3, step 3 refuses and the administrator reviews again. If the call stops
halfway, the person is verified but not permitted to drive, which is a legal state, and repeating the call finishes it.

**Revoke** (administrator, with a reason):

1. In one transaction set `canDrive: false` and clear the reviewer fields, and audit `EMPLOYEE_DRIVER_REVOKED`. From this moment the
   person cannot drive, whatever the verification says.
2. Then reject the driver and the vehicle using the existing `reviewVerification`, which already takes the driver offline and
   releases any matched riders back to searching (its current behaviour for a rejected driver).

**Removal** (A2a) already sets `canDrive: false` and suspends the profile, so a removed driver cannot go online (the existing
go-online check requires an active account).

## 4. Data and rules

- `CompanyMember` gains `driverRequestedAt: Timestamp | null` (null by default; the A2a member-creation code is updated to write it).
  The administrator's application list queries members where it is not null.
- No new collections. `drivers/{uid}` and `vehicles/{uid}` are reused unchanged. Their existing rules already let a driver read their
  own documents and nothing else, and they are keyed by uid, so they carry no company field.
- No rules change is needed. The administrator reads applicants only through `listDriverApplications`, which returns only the
  employee's name and email, the verification statuses and the vehicle's type, make, model and plate. **It never returns anything
  about trips, places or locations.**
- New audit actions: `EMPLOYEE_DRIVER_APPLIED`, `EMPLOYEE_DRIVER_APPROVED`, `EMPLOYEE_DRIVER_REVOKED`. The existing driver and vehicle
  review and vehicle-save actions are reused.

## 5. Limits that remain (stated, not hidden)

- **Verification is a decision, not a document check.** The platform has no upload of a licence, insurance or proof of ownership
  for any driver (`docs/security.md`: "No proof of ownership, registration document or plate lookup exists yet"). A company
  administrator therefore verifies on trust and whatever checks the company does outside the app. This matches what platform staff
  do today for consumer drivers, and it is the weaker vetting you accepted under Q5. Document upload would be a separate, larger
  module.
- **Plate numbers are unique across the whole platform.** An employee entering a plate that a consumer driver already registered is
  refused as "already registered", as today. That reveals nothing beyond what consumer drivers already see.
- **No push or in-app notice** tells an employee of the decision in A2b (the employee app shows status in A5).

## 6. Tests (A2b)

Emulator integration tests: apply (creates the profile once, repeat safe, refused for a removed or non-employee account); vehicle
save and capacity through the wrappers (same plate and seat rules, duplicate plate refused, refused before applying); the
administrator list (only the company's applicants, no places, not for non-administrators); approve (both verified and `canDrive`
true, audited, repeat safe, refused for self and for another company's member, refused when no vehicle, refused when the vehicle
changed mid-way); reject with reason and re-request; revoke (`canDrive` false first, then the driver is taken offline and
riders released, using a seeded online journey); and a mutation check on each guard. Unit tests for `hasEffectiveDriveCapability`.
After the module, the full regression gate against `docs/baseline-a0.md`.

## 7. Questions for review

1. **Self-approval refused.** An administrator who also wants to drive cannot approve themselves; another administrator must. This
   matches the existing rule that platform staff cannot review their own driver profile. A company with one administrator would
   invite a second to approve the first. Agreed?
2. **The effective-capability refinement** in section 2 (administrator permission AND current verification), instead of A1's single
   consistency invariant. Agreed?
3. **Rejection granularity.** The administrator rejects the driver profile or the vehicle separately, each with a reason (as platform
   staff do), while approval verifies both together. OK?
4. **What the administrator sees** about an applicant: name, email, verification statuses, and the vehicle's type, make, model and
   plate. Nothing about trips or places. OK?
5. **Verification on trust** (section 5): no document upload in v1. Acceptable for now?
