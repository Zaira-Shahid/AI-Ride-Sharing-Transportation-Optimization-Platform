# App store readiness (Phase 14, module 9)

The spec names this module ("App store preparation", Phase 14) and gives no detail. The only related
line is in the technology list: "Firebase Crashlytics where applicable". This document records what the
repository holds today, what a store release would still need and from whom, a plan for Crashlytics,
and a **draft** of the answers the two stores' privacy forms ask for.

It is a readiness record, not a submission. Nothing here was built into the apps, and nothing was
checked against a store, a device or a real Firebase project. The project is still on the Spark plan
with nothing deployed (`docs/security.md`, "App Check").

## What the apps declare today

Both mobile apps are Expo apps (`apps/passenger`, `apps/driver`). From each `app.json`:

| Setting                        | Passenger                | Driver                |
| ------------------------------ | ------------------------ | --------------------- |
| Name                           | RideMesh                 | RideMesh Driver       |
| iOS bundle identifier          | `com.ridemesh.passenger` | `com.ridemesh.driver` |
| Android package                | `com.ridemesh.passenger` | `com.ridemesh.driver` |
| Version                        | `0.0.0`                  | `0.0.0`               |
| Location permission text (iOS) | one line, see below      | one line, see below   |
| Orientation / theme            | portrait / light         | portrait / dark       |

The identifiers and names are the current values, **not confirmed as final**. They are hard to change
after a first store release, so they need an explicit decision before one.

## What a store release still needs

None of the following exists in the repository, and none of it can be created from code alone.

| Item                                                                                   | Who supplies it                                |
| -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Apple Developer and Google Play Console accounts                                       | the project owner                              |
| Signing keys and build credentials (an `eas.json` and an Expo project need an account) | the project owner                              |
| App icon and splash screen (there is no `assets/` folder in either app)                | the project owner (art is not invented here)   |
| Store listing text, screenshots, support URL, the review submission itself             | the project owner                              |
| A privacy notice at a public URL (both stores ask for one)                             | the project owner, after the legal decisions   |
| A Google Maps API key for Android (`react-native-maps` is used; none is in `app.json`) | the project owner, from a Google Cloud project |
| `google-services.json` / `GoogleService-Info.plist` per app, if Crashlytics is built   | the project owner, from the Firebase console   |
| A real deployment (Blaze plan) and App Check providers, before clients can enforce it  | the project owner                              |
| Target country, currency and legal requirements                                        | **not decided** (`docs/architecture.md`)       |

Two things found while reading the apps that are product decisions, not fixes made here:

- **The driver's location permission text was misleading, and is now corrected.** It read "RideMesh
  uses your location to show where you are on the map", but a driver's position is also written to the
  database while they are online (`updateDriverLocation`) and shown to the passenger matched to them.
  The driver app's text now says so: "RideMesh uses your location to show your location on the map, and
  to share your live position with matched passengers while you're online and sharing a trip." The
  passenger app's text is unchanged: it uses location only to centre its own map, and nothing in it
  sends the position to the server.
- **Push notifications are built on the server only.** `functions/src/pushTokens.ts` can store an Expo
  push token and the functions send notifications, but nothing in `apps/` or `packages/` calls it, and
  no notification package is in either app, so a phone is never registered to receive one. The privacy
  answers below therefore leave push tokens out until a client exists.

## Crashlytics: plan only, not built

Decided with the project owner: document it, do not build it yet.

What building it would take:

- **Native code, no web SDK.** Crashlytics reaches React Native only through `@react-native-firebase`
  (the `app` and `crashlytics` packages plus their Expo config plugins). The apps use the Firebase
  JavaScript SDK today (`@ridemesh/firebase`), which has no Crashlytics.
- **Development builds instead of Expo Go.** Native modules do not run in Expo Go, so running the apps
  changes to a development build (`expo prebuild` or EAS).
- **Real Firebase files**, one per app and platform, registered with the bundle identifiers above.
  They come from the Firebase console and are not invented.
- **Verification needs a device.** A crash report can only be proven by crashing a build and seeing it in
  the console. This was not possible while writing this document (Windows cannot build iOS; there is
  no device and no Firebase project with native apps registered).
- **A privacy consequence.** It adds crash and device diagnostics, an extra row in both store forms
  below.

When it is built, keep the call sites behind one small wrapper so the apps still run where the native
module is absent (web, tests), and send no personal data with a report (no name, email, trip place or
payment detail; at most the signed-in uid).

## Draft store privacy answers

**A draft, not legal advice.** It is written from what `docs/security.md` says the system collects. The
category names are the stores' as understood when this was written; check them against the current
forms before using them. Target country and legal requirements are not decided, so nothing here claims
compliance with a specific law.

| Data                                            | Collected                                                                              | Linked to the person | Purpose                                | Kept                                                                                                                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name, email address, phone number               | yes                                                                                    | yes                  | account, trip and driver contact       | until the account is deleted                                                                                                                                                                                  |
| Precise location: a passenger's trip places     | yes                                                                                    | yes                  | matching, routing                      | exact places cleared 30 days after a trip ends                                                                                                                                                                |
| Precise location: a driver's start and position | yes                                                                                    | yes                  | matching, showing the driver on a trip | position only while online, in the foreground; journey places on the same 30-day clock                                                                                                                        |
| Payment information                             | references only                                                                        | yes                  | fares, holds, refunds                  | Stripe customer, payment-method and payment ids and amounts; **no card number reaches the app or the database** (`docs/security.md`, "Payment compliance"); financial records kept after deletion, anonymized |
| User identifiers (sign-in uid)                  | yes                                                                                    | yes                  | account                                | until the account is deleted; audit entries keep the uid                                                                                                                                                      |
| Crash and device diagnostics                    | **no** (only if Crashlytics is built)                                                  | -                    | -                                      | -                                                                                                                                                                                                             |
| Push notification token                         | **no** (server side only; no client registers one yet)                                 | -                    | -                                      | -                                                                                                                                                                                                             |
| Advertising, third-party analytics, tracking    | none found: the dependency lists of both apps and the shared packages hold no such SDK | -                    | -                                      | -                                                                                                                                                                                                             |

Account deletion and a data export exist inside both apps (Profile, "Privacy and data"), which both
stores expect to be reachable. Backups keep a deleted account for up to 14 days (`docs/backup.md`); the
privacy notice has to say so, and the 30-day place retention, before real people use the apps.

## Decisions still needed

1. Final application names and bundle identifiers.
2. Icon and splash art, and who supplies it.
3. Whether the passenger's location permission text needs more than the map, if a later module sends their position anywhere.
4. When to build Crashlytics, and the Firebase files it needs.
5. Target country and legal requirements (also open in `docs/architecture.md`), which decide the
   privacy notice, the store forms and any payment-related rules.
6. Whether the apps will ever be submitted. Everything above is harmless to keep if not.
