# Production deployment (Phase 14, module 10)

**Status: written, intentionally not executed. Nothing in this document has been run, and it is deliberately not going
to be:** the project is presented as a completed portfolio project built and tested locally (Firebase
emulators and a local Python optimization service). The runbook is kept so a deployment can be
carried out later. Each step is done by hand, one at a time, and the next one starts only when the
owner says so. No secret value is written here or passed through the assistant: the owner sets those
themselves.

Project: `ai-ride-sharing-system-a6743` (pinned in `.firebaserc`). Region for everything:
`europe-west1`, to match the Functions' own region (`setGlobalOptions` in `functions/src/index.ts`).

| Piece                           | Where it runs                      | Notes                                                      |
| ------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| Optimization service (Python)   | Cloud Run, `services/optimization` | Existing `Dockerfile`; public, capped at 2 instances       |
| Cloud Functions, rules, indexes | Firebase, `europe-west1`           | Needs the Blaze plan; four scheduled functions (see below) |
| Admin dashboard (`apps/admin`)  | Vercel                             | Root directory `apps/admin`                                |
| Passenger and driver apps       | Not part of this module            | Store builds belong to app store readiness                 |

Order: Cloud Run first (the Functions need its URL), then the Functions, then Vercel.

## Things to know before starting

- **A budget alert is not a spending cap.** Google Cloud budgets email at the thresholds; they do not stop
  spending. The limits that actually bound cost are the instance caps: Cloud Run `--max-instances 2`
  and `maxInstances: 20` for the Functions. A hard billing kill-switch was considered and left out as
  too risky for this scale.
- **Four scheduled functions** become Cloud Scheduler jobs: `batchOptimizationRun`,
  `retryStuckRequestedTripsSweep` and `retryDelayedJourneysSweep` every 2 minutes, and
  `retryStaleAuthorizedHoldsSweep` every 5. Three jobs per billing account are free; the fourth costs
  about $0.10 a month.
- **The optimization service is public** (the Functions call it without credentials). See "Optimization
  service access" in [security.md](security.md).
- **Routing and geocoding use public community servers** by default (`routing.openstreetmap.de` and the
  public Nominatim). Fine for a demo; their policies want a contact in the User-Agent (step 2).
- **App Check stays off** (`ENFORCE_APP_CHECK` unset) until every client initialises it.
- **Stripe is test mode only.** The key and webhook secret live in the git-ignored
  `functions/.env.<project id>` file (see [development.md](development.md)).

## Step 0: the owner's own setup

1. Upgrade the project to the Blaze plan (Firebase console, Usage and billing).
2. Billing, Budgets and alerts: a budget of $10 a month with alerts at 50%, 90% and 100%, to an email
   the owner reads.
3. Install the `gcloud` CLI and run `gcloud auth login`. (`docker`, `firebase` and `vercel` are used too.)
4. Create Stripe test keys and a Google Places key. Restrict the Places key in Google Cloud to the Places
   API (New) and to the apps that use it; it ships inside the apps, so restriction is its protection.

## Step 1: Cloud Run (the optimizer)

From the repository root:

```bash
gcloud config set project ai-ride-sharing-system-a6743
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

gcloud run deploy ridemesh-optimization \
  --source services/optimization \
  --region europe-west1 \
  --allow-unauthenticated \
  --max-instances 2 --min-instances 0 \
  --memory 1Gi --cpu 1 --timeout 60

gcloud run services describe ridemesh-optimization --region europe-west1 --format "value(status.url)"
curl -s -w "\ntime=%{time_total}s\n" <SERVICE_URL>/health
```

The first deploy asks to create an Artifact Registry repository: answer yes. `--memory 1Gi` is a starting
point for OR-Tools plus scikit-learn; raise it to 2Gi if the service is killed for memory.

Verify: `/health` answers; note the cold-start time (the Functions give the service 30 seconds).

## Step 2: Firestore rules, indexes and Functions

Add to the git-ignored `functions/.env.ai-ride-sharing-system-a6743` (never commit it):

```text
OPTIMIZATION_SERVICE_URL=<SERVICE_URL>        # no trailing slash
STRIPE_SECRET_KEY=<test key>
GEOCODING_USER_AGENT=RideMesh (<a contact email>)
ROUTING_USER_AGENT=RideMesh (<a contact email>)
```

```bash
firebase use ai-ride-sharing-system-a6743
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only functions
```

Accept the prompt about a cleanup policy for the deployed images (it keeps storage cost down).

Verify: call `healthCheck` at the URL the deploy prints, and check `firebase functions:log --only
batchOptimizationRun` shows a run every 2 minutes. `maxInstances` is not enforced by the emulators, so
re-run a burst such as the 50 simultaneous estimates of [load-testing.md](load-testing.md) against the
deployed project once and note the result there.

## Step 3: Stripe webhook

In the Stripe dashboard (test mode), Developers, Webhooks, add the endpoint
`https://europe-west1-ai-ride-sharing-system-a6743.cloudfunctions.net/stripeWebhook`. Which events to
subscribe to is read from `functions/src/paymentWebhook.ts` when this step is done. Put the signing
secret in the env file as `STRIPE_WEBHOOK_SECRET=<signing secret>` and redeploy:

```bash
firebase deploy --only functions:stripeWebhook
```

## Step 4: Vercel (the admin dashboard)

1. Vercel, Add New Project, import this repository. A new project, separate from any other site.
2. Root Directory: `apps/admin`. Framework: Next.js. Leave "Include source files outside of the Root
   Directory" on, because the workspace packages are consumed as source.
3. Environment variables, from Firebase console, Project settings, the web app (public values):
   `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
   `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`,
   `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`,
   `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID`.
   **Do not set `NEXT_PUBLIC_FIREBASE_EMULATOR_HOST`**: it would point the dashboard at emulators.
4. After the first deploy, add the Vercel domain under Firebase console, Authentication, Settings,
   Authorized domains.

## Step 5: first staff account and a smoke test

1. Firebase console, Authentication, Add user (email and password).
2. `npm run admin:set-staff-role -- <email> ADMIN`, run against the real project with the owner's own
   Google credentials. (The script's prerequisites are confirmed when this step is done.)
3. Sign in to the dashboard and check: Live Network loads; **AI Predictions** shows its model metadata
   (this proves the Functions reach the optimization service); the Optimization page lists a run within
   about 2 minutes of a request.

## Rollback

```bash
# Cloud Run: send traffic back to the previous revision
gcloud run revisions list --service ridemesh-optimization --region europe-west1
gcloud run services update-traffic ridemesh-optimization --region europe-west1 \
  --to-revisions=<PREVIOUS_REVISION>=100

# Functions: check out the previous commit, then
firebase deploy --only functions
```

Vercel: Deployments, open the previous deployment, Promote to Production.

## Not part of this module

Mobile store builds and submission, Crashlytics, and the hardening items listed under "Known limitations"
in [security.md](security.md) (App Check, service-to-service authentication, secret management for live
payment keys).
