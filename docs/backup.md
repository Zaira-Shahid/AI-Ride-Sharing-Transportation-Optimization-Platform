# Backup and recovery

Phase 14, module 6 ("Backup strategy"). The spec names the module and nothing more: no targets, no
retention, no list of what to protect. Everything below is this project's own decision, made with the
user, and each decision says why.

> **Status: written, not applied.** The real project (`ai-ride-sharing-system-a6743`) is on the Spark
> plan, which cannot deploy functions and has no Firestore backups, point-in-time recovery or exports;
> nothing is deployed and there is no production data to protect yet. So this runbook and
> `scripts/backup.mjs` are ready, and have **never been run against a real project**. Every command is
> the Firebase CLI's own and a test (`tests/backup.test.ts`) checks that each flag is one the installed
> CLI documents, but that proves the spelling, not that a restore works. Rehearse in a throwaway project
> first (see "A rehearsal"). Turning this on is the checklist at the end.

## What is protected, and what is not

| What                                | How it is protected                                                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firestore (every collection)        | A daily managed backup kept 14 days, plus point-in-time recovery (minute-level versions for the last 7 days), plus delete protection so the database cannot be removed by accident. |
| Sign-in accounts (Firebase Auth)    | **Not** in a Firestore backup. A manual export (`auth-export`), weekly once real users exist, kept 14 days. This is the weakest part: it is a file someone has to remember to make. |
| Rules, indexes, functions, the apps | In git, and redeployed from git. `firestore.rules`, `firestore.indexes.json`, `functions/`, `apps/`. Losing the project does not lose the code.                                     |
| Secrets and settings                | **Not in git and not in any backup.** See the list below. Kept in whatever holds them at deploy time (decide then) and a copy in a password manager.                                |
| Stripe                              | Stripe's own durability. We keep only Stripe's ids (customer, payment intent). Nothing to back up on our side.                                                                      |
| Push tokens                         | Stored on the user documents, so they are in the Firestore backup. If lost, the apps register them again.                                                                           |
| The optimization service (Python)   | Stateless, rebuilt from git.                                                                                                                                                        |
| Cloud Logging                       | Google's, 30 days by default. The deleted-account record depends on it (below), so do not shorten it under 14 days.                                                                 |

Secrets and settings the functions read, none of which exist in git for a real project (the file
`functions/.env.demo-ridemesh` holds only the emulators' fake local settings):

- **Secret:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `EXPO_ACCESS_TOKEN` (optional).
- **Settings:** `OPTIMIZATION_SERVICE_URL`, `ROUTING_BASE_URL_DRIVING`, `ROUTING_BASE_URL_WALKING`,
  `NOMINATIM_BASE_URL`, `GEOCODING_USER_AGENT`, `ROUTING_USER_AGENT`, `GEOCODING_MIN_SPACING_MS`,
  `ROUTING_MIN_SPACING_MS`.

## Targets

None are in the spec. These are proposals, to be changed by a decision here:

- **Recovery point (how much can be lost):** about a minute for anything in the last 7 days
  (point-in-time recovery); up to a day for anything older, up to 14 days back (the daily backup).
- **Recovery time (how long to be back):** hours, not minutes. A restore makes a **new** database and
  then the app has to be moved onto it (see "A restore never goes over the live database").

## The settings, and why

- **Daily backup, kept 14 days.** Short on purpose. A backup still holds an account that was deleted
  after it was taken, so how long backups live is how long a deleted person's data can survive
  (next section). 14 days is long enough to notice a problem and short enough to state to users.
- **Point-in-time recovery on** (7 days). Covers the likely accident, a bad deploy or a bad script that
  damaged data a few hours ago, without needing to pick a daily backup.
- **Delete protection on.** Removing the database, the one thing a backup in the same database cannot
  undo, needs two steps.
- **Auth export weekly, kept 14 days.** The file holds emails and password hashes. Keep it in a private,
  access-restricted place, delete it after 14 days, and never commit it (`.gitignore` ignores
  `auth-export*` and `*-accounts.json`).

## Backups and the right to delete

This is the part that is easy to get wrong. Deleting an account (`docs/security.md`, "Your own data")
removes the person from the live database, but:

1. **A backup still contains them** until it expires: up to 14 days. The privacy notice must say so.
   Suggested wording: "We keep encrypted copies of our database for up to 14 days so that we can recover
   from a failure. If you delete your account, your data can stay in those copies until they expire."
   (Google encrypts Firestore data at rest by default.)
2. **A restore brings deleted accounts back.** Restoring a backup from the 3rd undoes a deletion made on
   the 5th. A restore must therefore be followed by **deleting those accounts again**. The audit log
   cannot tell you which ones: it lives in the database being restored, so the deletions after the
   backup are exactly what it loses.
3. **The record that survives is Cloud Logging.** Both deletion functions write a structured log entry
   `ACCOUNT_DELETED` with the account's uid and role, and nothing else (no name, email or plate), the
   same stance as the audit entry. Find them in Logs Explorer with
   `jsonPayload.event="ACCOUNT_DELETED"` and a time range from the backup's time to now. Keep Cloud
   Logging retention at 30 days (the default), never below the 14 days a backup lives.
4. **There is no tool yet that re-applies those deletions.** Doing it by hand across `users`, trip
   requests, receipts, journeys, earnings and notifications is error-prone. This is a known gap: build
   that tool before real people's data is in the database.
5. The 30-day removal of a finished ride's or journey's places runs again by itself after a restore
   (the daily sweeps are idempotent); nothing to do.

## A restore never goes over the live database

Every restore here (`restore-backup`, `restore-point-in-time`) creates a **new** database and leaves the
live one untouched; the script refuses `(default)` as the target. That is deliberate (a restore that
overwrites in place makes a bad restore unrecoverable), but it has a consequence to plan for:
**every part of the code uses the `(default)` database** (the functions, the admin scripts and both
client SDKs call `getFirestore()` with no database id). So after a restore the app is still pointed at
the old database. Two ways to finish, neither rehearsed:

- **A. Move the app onto the restored database.** Needs a code change (a configurable database id in the
  functions and the apps) that does not exist yet. Do this if it is built.
- **B. Put the restored data in `(default)`.** Take a final export of the damaged database for evidence,
  turn delete protection off, delete the damaged `(default)`, and restore the verified backup into
  `(default)`. Whether the CLI and Firestore allow restoring into `(default)` under that name has **not**
  been checked here: confirm it in Google's current documentation first, and rehearse it.

## What to do when

| Situation                                                    | Do this                                                                                                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data was damaged in the last 7 days (bad deploy, bad script) | `npm run admin:backup -- restore-point-in-time --at <a moment just before it> --into restored-<date>`, inspect it, then finish as A or B above.                |
| Older than 7 days, up to 14                                  | `npm run admin:backup -- status` to find the backup, then `restore-backup --backup <resource> --into restored-<date>`, then A or B.                            |
| The database was deleted                                     | Delete protection should have stopped it. If it did not: `restore-backup` into a new database, then A.                                                         |
| Accounts were lost                                           | `firebase auth:import <file>` from the latest export. It needs the project's password hash parameters (`--hash-algo` and the rest, from the Firebase console). |
| A secret leaked                                              | Rotate it at its source (Stripe, Expo), then update the deployed value. Backups do not help.                                                                   |
| After any restore                                            | Delete again the accounts deleted since the backup (see above), then run the integration checks you trust against the restored data before switching.          |

## The commands

`scripts/backup.mjs` prints the Firebase CLI command for each action and, by default, runs nothing:

```text
npm run admin:backup -- setup
npm run admin:backup -- status
npm run admin:backup -- auth-export auth-export-2026-10-02.json
npm run admin:backup -- restore-backup --backup projects/<id>/locations/<loc>/backups/<id> --into restored-1002
npm run admin:backup -- restore-point-in-time --at 2026-10-02T14:30:00Z --into restored-1002
```

Add `--run --confirm-production` to run what it printed (both flags: running against the real project
must not happen by accident). `--project <id>` overrides the project in `.firebaserc`. It refuses a
restore into `(default)`, a moment in the future or older than 7 days, and another project's backup.

## A rehearsal

Do this in a throwaway project on the Blaze plan before the first real one, then every quarter once
there is real data. A backup nobody has restored is a hope, not a backup.

1. `setup`, then `status`: confirm the schedule, PITR and delete protection are what this document says.
2. Put recognisable test data in, wait for a backup (or use PITR), damage it on purpose.
3. Restore into a new database, read the data back, and time how long it took (that is the real
   recovery time to write into "Targets").
4. Try option B above end to end and write down what actually happened.
5. Delete a test account, restore from before it, and re-delete it from the `ACCOUNT_DELETED` log entry.

## Turning this on (when the project moves to the Blaze plan)

- [ ] Upgrade the plan, and set a budget alert (backups and point-in-time versions are billed storage;
      not estimated here).
- [ ] `npm run admin:backup -- setup --run --confirm-production`, then `status` to see it took.
- [ ] Decide where the weekly auth export goes (a private bucket with restricted access and a 14-day
      lifecycle rule), and who makes it.
- [ ] Keep Cloud Logging retention at 30 days.
- [ ] Put the privacy notice's backup sentence in place (above).
- [ ] Do the rehearsal, and replace the proposed targets with the measured ones.
- [ ] Build the tool that re-applies deletions, and decide between A and B for cutting over.

## Known gaps

- Never run against a real project; the commands' spelling is checked, their effect is not.
- Auth accounts are only protected by a manual export.
- A restore needs either a configurable database id in the code (A) or an unverified in-place step (B).
- No tool re-applies deletions after a restore.
- The targets are proposals, not measurements.
