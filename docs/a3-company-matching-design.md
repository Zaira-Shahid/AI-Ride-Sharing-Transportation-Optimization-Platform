# A3 design note: company rides and tenant-safe matching

Status: draft for review. Nothing in this note is built. It follows `docs/a1-tenancy-design.md` (section 3, the central
invariant), `docs/a2b-driver-capability-design.md` (effective capability) and the Q2 and Q3 decisions in
`docs/product-a-corporate-requirements.md`. This is the one module that edits code consumers rely on, so the note is mostly about
how consumers are kept exactly as they are, and how that will be proved.

## 1. Proposed split: A3a and A3b

| Module  | Content                                                                                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A3a** | Company rides carry their company; matching and optimization never cross companies; company rides are free; employees can ride and drive through the existing functions; the proof that consumers are unchanged |
| **A3b** | The Q3 flow: a driver may decline an automatic match within a time limit, or the rider returns to searching                                                                                                     |

Q3 adds a new ride state and a timer, which is a separate risk from isolation. Keeping it out of A3a keeps the consumer-affecting
change small and reviewable on its own. This note designs A3a in full and only names A3b.

## 2. Settling null versus missing `companyId`

The A1 note flagged a trap: Firestore's `== null` matches only documents where the field exists and is `null`, not documents where it is missing, and
every existing consumer trip request and journey has **no** `companyId` field at all.

**Decision: never ask Firestore a question about `companyId`.** Instead:

- Consumer documents are **never written with the field**. They stay byte-for-byte what they are today. No backfill, no explicit `null`, no migration.
- Company documents get `companyId: "<id>"`.
- Code that needs to know a document's company reads it with one helper, `tenantOf(document)`: a non-empty string means that company, and
  **anything else (missing, `null`, empty) means "consumer"**. Missing and `null` are therefore the same by construction.
- The existing queries do not change at all. They already read every `SEARCHING` request and every `AVAILABLE` or `MATCHING` journey
  (the code's own comment says the pool is "small enough not to need a geospatial index yet"). The company split happens **in memory, after the read**.

This removes the trap entirely. It needs **no new Firestore index and no data migration**, and a consumer-only database
behaves as if A3a had never been written, because with no company documents the split is the identity.
The cost is the one the code already accepts: pools are read in full. If they ever outgrow that, a per-company query with an index is a
later, separate change.

## 3. Exactly where consumer matching is touched

Every place that reads `tripRequests` or `driverJourneys` was inventoried (about 50 sites). Only these change; the rest are
per-document operations that act on one known document and cannot pair across companies.

| Site                                                                                         | Change                                                                                                                                               | Effect on consumers                                               |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `optimizationRun.ts`, `matchIntoAvailableJourneys` (batch, phase 1)                          | After reading all open requests and available journeys, group them by `tenantOf`; run the **existing pipeline once per group**                       | The consumer group is exactly today's input, so today's output    |
| `planInsertion.ts`, `readMatchingJourneyPlans` and its pairing (phase 2)                     | A request is only tried against journeys of its own `tenantOf`                                                                                       | With no company data the filter passes everything                 |
| `matching.ts`, `findCandidateJourneysNow`                                                    | Takes the request's `tenantOf` and keeps only journeys of the same one (used by the candidate count and by `assignSearchingTripRequest`)             | Same: identity when everything is a consumer                      |
| Three places that commit a match: batch apply, insertion apply, `assignSearchingTripRequest` | A **second line of defence** inside the transaction: refuse and skip a pairing whose `tenantOf` values differ, even if a bug upstream proposed it    | Never fires for consumers (both sides are "consumer")             |
| `createTripRequest`, `declareDestination` (journey creation)                                 | Stamp `companyId` when the caller is an employee, taken from their membership, never from the request; consumers write exactly what they write today | Unchanged for consumers                                           |
| `captureTripPayment`, `completeDropoff`'s fare finalization                                  | Skipped when the ride belongs to a company (section 5)                                                                                               | Unchanged for consumers                                           |
| `firestore.rules`: trip, journey and plan reads                                              | Also accept the `EMPLOYEE` role, still tied to ownership by uid (section 6)                                                                          | A widening for a new role only                                    |
| `callers.ts` / `index.ts` entry points                                                       | An adapter lets an employee act as a rider or a driver (section 4)                                                                                   | A consumer's token takes the same path as now, with no extra read |

**Not touched:** the Python optimization service (it still receives one problem at a time and never sees two companies together),
routing and geocoding, the retention and failure-recovery sweeps, route modification and trip execution (they act on one journey or
trip already created), and the payment code beyond the skip above.

The batch run is the heart of it. Today one optimizer problem is built from everything. After A3a it is built once per group, so an
optimizer that assigned freely could still never mix companies, because it never receives a mixed set.

## 4. How an employee rides and drives

Employees use the **same callables** as consumers (the employee app in A5 needs no parallel API). At each entry point
(`createTripRequest`, `cancelTripRequest`, `declareDestination`, `setJourneySeats`, `setJourneyDetour`, `setJourneyOrigin`,
`setAvailability`, `updateDriverLocation`, and the driver's trip steps) a small adapter picks the caller:

- **Token role is `DRIVER` or `PASSENGER`:** exactly today's path. No extra read, no new code reached.
- **Token role is `EMPLOYEE`:** the adapter reads the membership document and refuses unless the person is an **active member of an
  active company**; for a driving action it also requires the **effective capability** from A2b (permission **and** a currently
  verified driver and vehicle). It then calls the same internal function with a caller that has the role the function expects and the
  company id attached.
- The company id comes from the membership document, **never from anything the client sends**.

Routing and geocoding lookups, which hold no company data, simply also accept the `EMPLOYEE` role (the check is token-only today).

**Rider and driver at once.** The existing model keeps one open request and one open journey independently. For employees only:
an employee with an open request cannot go online as a driver, and the reverse, enforced server-side in the adapter and tested.

## 5. Company rides are free (Q2)

- A ride is a company ride when its `tenantOf` is a company. Capture is skipped for it (and refund, void and earnings are
  unreachable, since no payment exists). `completeDropoff` skips fare finalization, so `finalFareMinorUnits` stays empty and `paymentStatus` stays empty.
- No receipt and no driver earning is ever written for a company ride.
- Stripe is never contacted for one, even when Stripe is configured.
- Consumer completion is unchanged. The skip is keyed on the company, not on whether Stripe is set up.

## 6. Rules change

`firestore.rules` today lets a rider read their trip when `role() == 'PASSENGER'` and a driver read theirs when `role() == 'DRIVER'`
(and similar for journeys and plans). An employee's token role is `EMPLOYEE`, so the same checks gain `|| role() == 'EMPLOYEE'`,
**still requiring the document's own `passengerId`, `matchedDriverId` or `driverId` to equal their uid**. No cross-person read is opened,
and the existing rule tests are the baseline for it.

## 7. The proof that consumers are unchanged

This is the part the review should hold me to. It has two layers.

**Layer 1: nothing existing may need editing.** Every existing integration test that exercises consumers must pass **with its file
unmodified** after A3a. The report will show `git diff` for those files as empty. The suites: `matching` (20 tests),
`optimizationRun`, `optimizationTrigger`, `planInsertion` (9), `phase6-acceptance`, `phase8-acceptance`, `routeModification`,
`tripExecution`, `trip-request`, `journey`, `location`, every `payment*` file, `firestore-rules`, and the unit tests. A test that has to
change to pass would itself be a finding.

**Layer 2: a before-and-after comparison, built first.**

1. **Characterization commit, before any A3a code.** On unmodified `develop`, I add a test that runs a fixed, deterministic consumer
   scenario through every matching path (the batch run, insertion into a matching journey, the on-create candidate count, and trip
   execution to completion) using the scripted fake optimizer and routing the existing tests already use. It records a normalized
   result (which request got which driver, plan stop order, statuses, counts, notifications, the exact **key set** of every document
   written) as a committed golden file. That commit is reviewable on its own and passes on today's code.
2. **After A3a, the same test must produce the identical golden file.** Not "similar": identical.
3. **Mixed-world test.** The same consumer scenario is run **again with company noise in the same database**: two companies and
   some employees, with routes deliberately overlapping the consumers'. The consumer results must still equal the golden file, and
   no company ride may be matched with a consumer driver or with another company's driver, through every path (batch, insertion,
   on-create count, assign).
4. **Hostile optimizer.** A fake optimization service that "helpfully" assigns every request to the first journey it is given, whatever
   the tenant, proves isolation comes from the split and not from the optimizer's good manners. A crafted mixed pairing fed
   straight to each of the three commit points must be refused by the second line of defence.
5. **Document shape.** A consumer-written trip request and journey have exactly the same keys as before (no `companyId`, not even `null`).
6. **Free rides.** A company ride completed with Stripe configured never calls Stripe and writes no receipt or earning; a consumer
   ride completed in the same run still does.
7. **Employee entry points.** Consumer tokens never reach the employee adapter's reads (checked by counting reads); an employee
   without the effective capability cannot drive; an employee with an open request cannot go online, and the reverse.
8. **Mutation check** on each guard: turn off the grouping, each of the three defences, the stamping, the payment skip, the rider-and-driver rule, and the
   rules widening, one at a time, and confirm a test fails for each.

Then the full regression gate against `docs/baseline-a0.md` (unit and integration, including the optimizer files through Docker).

## 8. Platform staff views (a decision, with a default)

The admin console's trip monitoring, live map and analytics read all trips. Company rides will appear in them unless filtered.
Default for A3a: they **appear like any ride, with the same privacy rules** (first names only, exact places only through the audited
detail call), and are marked as company rides. Company administrators see only aggregates (module A7), never trips or places.

## 9. Risks

| Risk                                                             | Mitigation                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The grouping subtly changes consumer batch results (order, ties) | Layer 2 golden test, written first against today's code; the consumer group is built from the same read in the same order  |
| An unconsidered path pairs across companies                      | Inventory of all sites; second line of defence at each of the three commit points; mixed-world and hostile-optimizer tests |
| Pools grow with company data and slow the global read            | Accepted for now (the code's own stance); a per-company indexed query is a later change if needed                          |
| Optimization run logs now have one entry per group               | Consumer group logs exactly as before; company groups log with their company id                                            |
| An employee action reaches a consumer-only function by mistake   | The adapter is the only way in; tests list every entry point and its allowed roles                                         |

## 10. Questions for review

1. **Split into A3a and A3b** (section 1), with the decline-within-a-time-limit flow in A3b. Agreed?
2. **Never query by `companyId`; split in memory after the existing reads** (section 2). It means no migration and no new index, at the cost of keeping the
   read-everything approach the code already has. Agreed?
3. **Shared callables with an adapter** (section 4), rather than separate employee-only functions. Agreed?
4. **An employee cannot be a rider and a driver at the same moment** (section 4). Agreed?
5. **Platform staff see company rides** in the admin console, with the same privacy rules and a marker (section 8). Agreed, or should
   company rides be hidden from platform monitoring?
6. **Characterization first** (section 7): a separate commit that records today's consumer behaviour before any change. Agreed?
