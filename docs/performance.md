# Performance

Phase 14, module 2. Spec section 69 gives targets that are mostly words ("low-latency", "near
real-time", "responsive") and one number (trip request creation under 1 second, excluding external
APIs), and says the real targets "should be validated through load testing" (a separate module).
Section 71 is more concrete: avoid **unbounded queries**, excessive writes and massive documents; use
indexes, pagination and aggregation. This module is therefore an audit against section 71, the fixes
that were clear, and a measured baseline. It is not load testing.

> **Every number below is from the Firebase emulators on one developer machine**: no network to a data
> centre, almost no cold starts, no other load. They show whether something got slower or scales badly
> (the shape), not how long a real request takes (the value). Nothing here has been measured on the
> real project, which is on the Spark plan with nothing deployed.

## Measured (`npm run perf`)

`npm run perf` starts the emulators and runs `tests/perf/performance.perf.test.ts`, which writes what
it measured to `tests/perf/last-run.json` (git-ignored). It is not in CI: wall-clock time on a shared
runner proves nothing and would make a test flaky. It asserts only that what it timed succeeded.

| Measured                                                                                       | Result                                                   | Spec target                      |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------- |
| `createTripRequest`, as the passenger app calls it (30 calls, warmed up)                       | median **85 ms**, 95th percentile 105 ms, slowest 107 ms | under 1,000 ms (section 69)      |
| First page of the admin Drivers list (50 rows, each joined to user and vehicle) at 100 drivers | median 456 ms                                            | "responsive with large datasets" |
| The same first page at 1,000 drivers                                                           | median 289 ms                                            |                                  |
| Reading all 1,000 drivers, page after page (what the page used to do)                          | 4,454 ms                                                 |                                  |

How to read those:

- `createTripRequest` is far under the target here. It makes no external call itself (the route estimate
  and the matching run afterwards, from triggers), so "excluding external APIs" is how it is built. The
  real figure includes a network round trip and a cold start that the emulators do not have.
- **The first page does not grow with the list.** 100 and 1,000 drivers are the same order; the first
  figure is higher only because it also pays for warming up (the order of the two runs, not the size).
  Reading everything is what grows: about 15 times the first page at 1,000 drivers, and linear in
  the drivers beyond that. "Reading all, page after page" is an approximation of the old single read
  (20 round trips instead of one read plus two per-row reads), of the same order.

## The audit, against section 71

A heuristic scan of `functions/src` found **30 queries that read documents, 14 with a `limit` and 16
without**; none reads a whole collection (all are filtered). It cannot see a query built in another
function or a client read, so the client reads in `packages/firebase` were checked by hand as well.

| Where                                                                                                    | What it reads                                                                             | Decision                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Admin Drivers, Vehicles, Passengers pages (`packages/firebase`)                                          | **every** driver, vehicle, passenger, in the browser                                      | **Fixed: a page of 50 and "Load more"** (below).                                                              |
| Analytics `peopleTransported` / `vehiclesUsed` (`functions/src/analytics.ts`)                            | **every** completed trip, on every call                                                   | **Fixed: the newest 5,000, from one read** (below).                                                           |
| Export and deletion of one person's data (`dataRights.ts`, `driverDataRights.ts`)                        | that one person's own records                                                             | Left: bounded by one person's history; the export is capped at 500 of each kind and deletion works in chunks. |
| Retry sweeps (`failureRecovery.ts`) and the retention sweeps (`tripRetention.ts`)                        | stuck items only; retention in batches of 200                                             | Left: bounded by what is stuck or expired.                                                                    |
| Matching, the batch optimization and insertion (`matching.ts`, `optimizationRun.ts`, `planInsertion.ts`) | **every active journey** and every searching request, on each request and every 2 minutes | **Left, deliberately.** See below.                                                                            |
| Admin live map                                                                                           | every active journey, live                                                                | Left, with the matching reads: it is the same set, and it is a live view.                                     |
| Trip lists                                                                                               | 50 (the passenger's) and cursor pages (staff history)                                     | Already bounded.                                                                                              |

### Fixed: the admin lists

The Drivers, Vehicles and Passengers pages read every document of their collection in the staff
member's browser, and joined each row to its user and vehicle with two more reads. They now read a
page of 50 plus one (the extra one says whether there is a next page, so a list that is exactly one page
long does not offer an empty "Load more"). The order is the database's own, so a page is never
re-sorted in the browser and the next page continues exactly where the last stopped:

- Drivers and vehicles: `verificationStatus`, then document id. PENDING, REJECTED, VERIFIED happen to sort
  that way, so the actionable ones come first (it was "pending, then everyone else" before; rejected now
  come before verified).
- Passengers: `status` descending then document id descending, so SUSPENDED come first. This needs a
  composite index on `users` (`role`, `status`), added to `firestore.indexes.json`.
- After a review or suspension the list starts again from the first page, because the row moves.

**Indexes are not checked by the emulators.** The passenger index is declared. Drivers and vehicles rely
on the automatic single-field index (ordering by a field and then by document id is that index's own
order); confirm that when the indexes are deployed.

### Fixed: the analytics distinct counts

Firestore has no count-distinct aggregate, so "people transported" and "vehicles used" read every
completed trip on every analytics call. They now read the newest 5,000
(`ANALYTICS_DISTINCT_TRIP_CAP`), and from **one** read, not two. Up to 5,000 completed trips they are exact.
Beyond that they are lower bounds, the page says so, and the two figures made from them are **withheld, not
shown wrong**: vehicle trips avoided is `max(0, people - journeys)` with an all-time journey count, and a
lower bound for people would quietly make it read 0. The estimated emissions are built on it, so they are
withheld too. The real cure at that scale is a running counter, which is a bigger change than this.

### Left, deliberately: matching reads every active journey

Each new request, and the optimizer every 2 minutes, reads every active journey and every searching
request. That is a cost proportional to the active network, and the cure (a geographic filter, such as a
geohash index) is a design change. Spec section 70 says not to bring in the later infrastructure before
the product needs it, and there is no real traffic to say at what size it starts to matter. The
measurement that would say so is the load test (the next module), and the trigger to revisit is the
figures it produces, not a guess made now.

## What this does not cover

- **Production numbers.** All of the above is emulator-only.
- **Load.** One caller at a time. How it behaves with many at once (contention on shared counters such as
  the route rate limit, trigger fan-out) is what load testing is for.
- **Location updates** (spec section 72) and **writes**: section 71 also asks to avoid excessive writes and
  to throttle location updates. This module did not audit them.
- **The live map's own subscription** and the per-row joins in the lists (two extra reads a row) are as
  they were; a page of 50 bounds the second.
- The scan is a heuristic. It is evidence, not proof that nothing else is unbounded.
