# Load testing

Phase 14, module 3. This module measured and reported; the one fix it led to (the estimate's route
counter) is described under A2. Its question is what happens to the one thing every request and every
match needs, a route lookup, when many people use the system at once. Location updates are not covered (they do not use route lookups).

> **Every number below is from the Firebase emulators on one developer machine**, with a fake routing
> server that answers after 150 ms. Nothing was run on the real project (Spark plan, nothing
> deployed) or against a real routing server. Treat the numbers as shape, not value, and read the
> caveats on each scenario.

## How to run it

`npm run load` (about 10 minutes; not in CI). It starts the emulators under the project
`demo-ridemesh-load`, whose `functions/.env.demo-ridemesh-load` points routing at a fake server and,
deliberately, does **not** loosen the route limits, so the real ones apply: one lookup for the whole
system every 1.1 s (`globalSpacingMs`), 20 per person per minute. Results are written to
`tests/load/last-run.json` (git-ignored, one section per test file).

## The limit that matters

Every route lookup that is not answered from the cache has to be counted, so that the routing
server is asked at most once every 1.1 s by everybody together (and 20 times a minute by one person).
That makes the counter the bottleneck for everybody: at most about 55 lookups a minute.

The counter was one document (`routeGlobal/lookups`) that every caller wrote in a transaction, and
a caller that found the provider used a moment ago was told `busy`. Scenario A2 below shows what that
did to a burst, what a first fix did, and the design that now holds (one document per slot, last
section of A).

## A. A burst of trip requests

**A1, through the emulator's triggers** (`load.load.test.ts`): N passengers each call
`createTripRequest` at the same moment; we poll until each request has its estimate.

| Burst | Estimated eventually | Last estimate after | Create time (median / p95) |
| ----: | -------------------: | ------------------: | -------------------------: |
|    10 |                10/10 |              24.0 s |              7.3 s / 7.6 s |
|    25 |                25/25 |              35.2 s |              0.6 s / 5.8 s |
|    50 |                50/50 |              58.6 s |            17.5 s / 21.0 s |

(Before the slot booking of A2 the last estimate came after 29.4 s, 48.8 s and 93.0 s; the estimate trigger now books slots, so the queue is shorter.)

**This does not show what production would do.** The emulator runs a background trigger one
invocation at a time (its log shows at most 1 `estimateTripRequestOnCreate` running at once, against
up to 15 callables), so the estimates were worked through one behind another, never at the same moment. The create times are
the emulator coping with 50 callables at once, not a measure of Cloud Functions.

**A2, estimates running at the same time** (`estimateBurst.load.test.ts`): the function the trigger
runs, `estimateTripRequest`, called for N requests at once in one process, with the real limits and
150 ms added to every lookup. This is closer to what concurrent instances would do.

Three versions of the counter, the same test:

| Burst | One document, told `busy` (the old design) | One document, a booked slot, retries | One document **per slot** (now) |
| ----: | -----------------------------------------: | -----------------------------------: | ------------------------------: |
|    10 |                             6/10 estimated |                       10/10 (17.8 s) |                  10/10 (11.7 s) |
|    25 |                             5/25 estimated |                       25/25 (44.3 s) |                  25/25 (28.8 s) |
|    50 |                             2/50 estimated |                    21/50, took 474 s |                  50/50 (57.2 s) |

The last column shows the first of three runs of the same test, which gave 10/10, 25/25 and 50/50 every time; the 50-burst
took 57.2 s, 57.2 s and 58.2 s, against the 55 s that 50 lookups 1.1 s apart need at the very least.
The first column also has a plain design cause (all the refused callers came back together every
1.3 s, so each round let one through and four attempts reached about four callers), and an
instrumented run showed the second cause: 135 `Transaction lock timeout` aborts on the one counter
document, each treated as `busy`.

- **The slot booking** (`reserveLookupSlot`, `functions/src/lookupLimits.ts`): the line is a row of
  slots 1.1 s apart; booking one is creating its document, which fails at once if somebody else has
  it, and then the next slot is tried, so callers never wait on a lock. The caller sleeps until its
  slot, up to 60 s (`ESTIMATE_SLOT_WAIT_MS`); beyond that it is told `busy` as before and
  retries a few times. About 54 estimates at the same moment fit.
- **Only the estimate uses it.** The batch run, matching and route previews still use the old
  `claimLookup`, which now also keeps clear of any booked slot, so the provider is not asked closer
  together than 1.1 s by either way in. One small gap: `lastAt` is read once before booking, so a
  `claimLookup` landing in that instant can end up closer than 1.1 s.
- **Not shown:** that production behaves like the emulator. Firestore on the real service handles
  contention differently, so the first two columns may be better or worse there; the per-slot
  design avoids the shared document altogether, which is why it is the one kept, but it should still
  be run against the real project before launch. The 150 ms lookup time is an assumption, and a
  trigger that waits up to 60 s holds a function instance that long (the trigger's timeout is 90 s).

## B. A batch optimization run, by network size

`runBatchOptimization` on N available journeys and N searching requests (zero-latency routes, the
real Python optimization service), counting the lookups it makes. The last column is how long those
lookups alone would take at the real limit of one per 1.1 s.

| Journeys = requests | Matched | Inserted | Route lookups | Measured here | At the real limit |
| ------------------: | ------: | -------: | ------------: | ------------: | ----------------: |
|                  10 |       2 |        0 |            26 |         2.6 s |           0.5 min |
|                  25 |       3 |        1 |            77 |         6.9 s |           1.4 min |
|                  50 |      12 |        1 |           403 |        39.9 s |           7.4 min |
|                 100 |      41 |        7 |         2,886 |       258.5 s |          52.9 min |

Lookups grow faster than the network (about 7x from 50 to 100). The batch run is scheduled every
2 minutes, so on a network of 50 journeys and 50 waiting requests one run needs about 7 minutes of the
shared lookup budget, and one of 100 needs almost an hour, during which nothing else (estimates,
route previews) can get a lookup either. These are sizes of a loaded test network, with every request
open at once; the real mix is unknown.

Not checked: whether a run of 100 fits the function's time limit (`batchOptimizationRun` sets no
explicit `timeoutSeconds`); the run here was in-process, not as a deployed function.

## Summary

1. **The single route counter is the bottleneck.** Both scenarios come back to it.
2. **Concurrent estimates mostly gave up in the emulator** (6/10, 5/25, 2/50). Fixed for the
   estimate by booking a slot per caller, one document per slot (10/10, 25/25, 50/50, three runs).
   Unproven for production; worth testing on the real project.
3. **A batch run's lookups grow faster than the network** and would, at the real limit, be longer than
   the 2-minute interval somewhere between 25 and 50 journeys.
4. The estimate's counter was changed (see A2); nothing else was. Candidates for a later module, none
   done: the same slot booking for the batch run and matching, caching or batching route lookups for
   the batch run, a longer interval.
