# Baseline A0 (before Product A work)

Recorded 2026-11-17 on `develop` at bb2d236, plus the A0 changes (Docker option for the optimizer tests, removal of the unused
`services/optimizer` placeholder, refreshed `docs/architecture.md`). Every Product A module is compared against this.

## Results

| Check                                    | Result                                                  |
| ---------------------------------------- | ------------------------------------------------------- |
| Unit tests (`npm test`)                  | **39 files, 716 tests, all pass**                       |
| Typecheck, lint, format                  | clean                                                   |
| Integration (`npm run test:integration`) | **54 files, 937 tests, all pass, none skipped** (550 s) |
| Flaky tests seen in this run             | none                                                    |

The integration run used the real Python optimization service, run from a Docker image (see below).

## Running the optimizer tests

Three integration files start the real optimization service: `mlPredictions`, `phase6-acceptance` and `phase8-acceptance`.

- **Normal machines:** create `services/optimization/.venv` and install `requirements-dev.txt`. The tests use it automatically.
- **Machines where native Python libraries are blocked** (for example Windows Smart App Control blocking numpy's compiled modules,
  as happened here): build the image and tell the tests to use it.

```bash
docker build -t ridemesh-optimization:test services/optimization
export OPTIMIZATION_SERVICE_DOCKER_IMAGE=ridemesh-optimization:test
npm run test:integration
```

The test helper (`tests/optimization-service.ts`) then runs the image on port 18891 and removes the container when it finishes.
With the variable unset, behaviour is unchanged. Integration runs also need Java for the Firestore emulator. On this machine it is
the JDK bundled with Android Studio, added to `PATH` for the run.

## Notes

- `npm run test:integration` can print "An unexpected error has occurred" and exit with a non-zero code **after** the line
  "Script exited successfully (code 0)". It happens while the Firestore emulator shuts down on Windows. Judge the run by the
  vitest summary, not by that exit code.
- Before the Docker option, the same run showed 926 passed, 11 skipped and 3 files unable to start (the three above). All three pass
  with the Docker image.
- Not run for this baseline: Playwright end-to-end tests (`npm run test:e2e`), load and performance tests, and the Python service's
  own pytest suite. They are not part of the per-module regression gate defined in `docs/product-architecture.md`.
- Known issues from earlier notes (trip-history cursor millisecond truncation, timing flakes in the real-optimizer tests) did not show
  up in this run. They stay on the list until reproduced or ruled out.
