# Load testing

Phase 14, module 3. This module **measures and reports; it fixes nothing.** Its question is what
happens to the one thing every request and every match needs, a route lookup, when many people use the
system at once. Location updates are not covered (they do not use route lookups).

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

`calculateRoute` counts every lookup in a Firestore transaction on a single document
(`routeGlobal/lookups`). That is what keeps the routing server's usage polite, and it makes that one
document the bottleneck for everybody: at most about 55 lookups a minute, and every caller that finds
it taken is told `busy`.

## A. A burst of trip requests

**A1, through the emulator's triggers** (`load.load.test.ts`): N passengers each call
`createTripRequest` at the same moment; we poll until each request has its estimate.

| Burst | Estimated eventually | Last estimate after | Create time (median / p95) |
| ----: | -------------------: | ------------------: | -------------------------: |
|    10 |                10/10 |              29.4 s |              7.6 s / 7.7 s |
|    25 |                25/25 |              48.8 s |              0.5 s / 5.3 s |
|    50 |                50/50 |              93.0 s |            17.2 s / 20.7 s |

**This does not show what production would do.** The emulator runs a background trigger one
invocation at a time (its log shows at most 1 `estimateTripRequestOnCreate` running at once, against
up to 15 callables), so the estimates queued up and each found the counter free. The create times are
the emulator coping with 50 callables at once, not a measure of Cloud Functions.

**A2, estimates running at the same time** (`estimateBurst.load.test.ts`): the function the trigger
runs, `estimateTripRequest`, called for N requests at once in one process, with the real limits and
the real retry (4 attempts, 1.3 s apart). This is closer to what concurrent instances would do.

| Burst | Estimated | Gave up (`unavailable`) | Route lookups made | Everyone answered after |
| ----: | --------: | ----------------------: | -----------------: | ----------------------: |
|    10 |         6 |                       4 |                  6 |                  28.1 s |
|    25 |         5 |                      20 |                  5 |                  21.6 s |
|    50 |         2 |                      48 |                  2 |                  69.7 s |

Most estimates are given up on. A request that gave up has no estimate until something else computes
one; the app says the estimate is not available once it has waited long enough.

What this does and does not tell us:

- **It is not just the 1.1 s spacing.** In 69.7 s the limit would have allowed about 60 lookups; 2
  were made. The counter's transaction fails under contention (many writers on one document) and
  `calculateRoute` treats a failed transaction as `busy`, so the callers burn their 4 attempts on
  contention. This is the same mechanism seen in the phase8 flake investigation.
- **Whether production behaves the same is not shown.** Firestore on the real service handles
  contention differently from the emulator (it retries transactions itself, with locking). The
  mechanism, many callers on one document, is the same, and the result here is a reason to
  test it on the real project before launch, not proof that launch would look like this.
- The 150 ms lookup time is an assumption. A real server's latency was not measured.

## B. A batch optimization run, by network size

`runBatchOptimization` on N available journeys and N searching requests (zero-latency routes, the
real Python optimization service), counting the lookups it makes. The last column is how long those
lookups alone would take at the real limit of one per 1.1 s.

| Journeys = requests | Matched | Inserted | Route lookups | Measured here | At the real limit |
| ------------------: | ------: | -------: | ------------: | ------------: | ----------------: |
|                  10 |       2 |        0 |            26 |         2.5 s |           0.5 min |
|                  25 |       3 |        1 |            77 |         7.6 s |           1.4 min |
|                  50 |      12 |        1 |           403 |        40.2 s |           7.4 min |
|                 100 |      41 |        7 |         2,877 |       262.9 s |          52.7 min |

Lookups grow faster than the network (about 7× from 50 to 100). The batch run is scheduled every
2 minutes, so on a network of 50 journeys and 50 waiting requests one run needs about 7 minutes of the
shared lookup budget, and one of 100 needs almost an hour, during which nothing else (estimates,
route previews) can get a lookup either. These are sizes of a loaded test network, with every request
open at once; the real mix is unknown.

Not checked: whether a run of 100 fits the function's time limit (`batchOptimizationRun` sets no
explicit `timeoutSeconds`); the run here was in-process, not as a deployed function.

## Summary

1. **The single route counter is the bottleneck.** Both scenarios come back to it.
2. **Concurrent estimates mostly gave up in the emulator** (6/10, 5/25, 2/50). Unproven for
   production; worth testing on the real project.
3. **A batch run's lookups grow faster than the network** and would, at the real limit, be longer than
   the 2-minute interval somewhere between 25 and 50 journeys.
4. Nothing was changed. Candidates for a later module, none done: more attempts or a wait that grows
   for the estimate, a counter that is not one document, caching or batching route lookups for the
   batch run, a longer interval.
