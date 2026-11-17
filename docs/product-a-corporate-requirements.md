# Product A: Corporate Carpooling, requirements

Status: draft for review. Nothing here is built yet.

## 1. Purpose

Let a company organize employee commuting through a structured carpool: employees ride with colleagues, the company
sees activity and statistics, and the whole thing is usable by voice. It is an evolution of RideMesh. It reuses the
matching and trip engine, adds a company (tenant) layer, and leaves the existing consumer apps working exactly as they are.

## 2. Decisions already made

- Evolution of RideMesh, not a rewrite or fork; the consumer passenger/driver apps keep working unchanged.
- Voice uses free, on-device speech only: text-to-speech for spoken output and on-device speech recognition for menus. No
  paid provider, no phone/IVR service.
- Product A is built completely before Product B.
- Deployment is paused until both products are built and tested.
- Work goes in feature branches merged into `develop`, with regular pushes.
- **Regression gate (2026-11-17):** after every Product A module, the existing RideMesh unit and integration suites are run
  and must pass before the next module starts. If the tenancy layer breaks anything existing, it is fixed first. The result is
  recorded in each module's report.
- Employee app is a new `apps/employee`; the passenger and driver apps stay untouched (D1).
- One employee can both drive and ride: a driver capability is added on top of the existing role (Q1).
- Company carpooling is free in v1; Stripe payments are off for company rides (Q2).
- Matching is automatic; the driver may decline within a time limit, else the request returns to searching (Q3).
- The company admin verifies their own employee-drivers, not platform staff (Q5).
- No platform approval for new companies (Q4), no recurring commutes in v1 (Q6), English-only voice first (Q7).

## 3. Roles

| Role           | Who                         | Can do                                                                                                                              |
| -------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Company admin  | A person at the company     | Manage company profile/settings, invite and remove employees, view company dashboard (aggregates only), see pending requests counts |
| Employee       | A company member            | Set home/work, commute preferences, post a ride offer, request a ride, accept/reject requests, manage upcoming rides, use voice     |
| Platform staff | Existing roles              | Existing admin console; can also see companies (read-only for support; details in the architecture doc)                             |
| Consumer users | Existing passengers/drivers | Unchanged. Never see or match with company rides                                                                                    |

A company admin is not platform staff and gets no access to other companies or to the consumer network.

## 4. Functional requirements

### 4.1 Company onboarding and management

- C1. A company is created by a signup flow for its first admin (name, work site address, contact email). New companies start
  as `ACTIVE` unless Q4 says otherwise.
- C2. Company profile and settings: name, sites (one or more work addresses), default commute window, whether employees may
  see each other's first names, voice defaults.
- C3. Company admin can invite employees by email, resend and revoke invitations, and remove or suspend an employee.
- C4. Invitations are single-use, expire (default 7 days), and are bound to the invited email. Joining requires a verified email.
- C5. An employee belongs to exactly one company in v1.

### 4.2 Employee features

- E1. Invitation-based onboarding: accept invite, set name/phone, home location, work site, commute times.
- E2. Create a ride offer (drive): date/time window, seats, detour tolerance (existing journey model).
- E3. Request a ride: pickup, destination, time window.
- E4. Matching: only against colleagues of the same company, using the existing engine (route, destination, time, seats).
- E5. Accept/reject: a driver can accept or reject a match before it is final. Decision rules in Q3.
- E6. Ride status and notifications (in-app, push, and spoken per section 5).
- E7. Manage upcoming rides: view, cancel, change seats/time.
- E8. Recurring commutes (for example, weekdays 8:00) are desirable. Scope in Q6.

### 4.3 Corporate dashboard (web, company admin)

- D1. Employee activity: invited, joined, active in the last 30 days.
- D2. Ride activity: rides offered, completed, cancelled, seats filled, per day/week.
- D3. Available rides and pending requests as counts and time distribution.
- D4. Basic transport statistics: shared rides, average occupancy, distance shared. Emissions are only shown if a
  methodology is agreed (the existing admin console defers this too).
- D5. Company settings and employee management screens.
- **Privacy constraint:** the dashboard shows aggregates and employee names/status only. It never shows an employee's exact
  home or trip locations. The existing platform rule that nobody but the rider and matched driver can read trip places is kept.

### 4.4 Voice (on-device, free)

See the architecture doc for how. Requirements:

- V1. Spoken output: ride updates (match found, driver on the way, pickup, arrival, cancellation, request received) and
  announcements, while the app is open.
- V2. Voice menu: hands-free navigation of core actions (hear today's ride, offer a ride, request a ride, accept/reject a
  request, cancel, repeat). Every voice action must have an equivalent touch action.
- V3. Confirmation by voice for any action that changes state (accept, reject, cancel) before it runs.
- V4. Accessibility: works with screen readers, large text, and captions of everything spoken. A user can turn voice off.
- V5. A visible, honest status: if speech recognition is unavailable on the device, the app says so and falls back to touch.

**Stated limits.** Free on-device speech cannot ring a phone or speak while the app is closed. A push notification shows text,
not custom audio. Voice menus therefore work inside the app, not by phone call. A real phone/IVR menu would need a paid provider and
is out of scope unless you later approve one.

### 4.5 Non-functional

- Mobile-first; desktop compatibility for the company dashboard.
- Role-based access, server-side validation (zod schemas shared with clients), audit entries for company/employee changes.
- No secrets in code; environment variables only. Test data only, never real personal data.
- Rate limiting on invitation sending and sign-up. Input sanitization on all free-text fields.
- Automated tests per module: unit, emulator integration, rules tests, and e2e for the main journey.

## 5. Out of scope for Product A v1

- Phone calls / IVR / any paid voice or SMS provider.
- Multi-company membership for one person.
- Company billing, subsidies, or invoicing (unless Q2 changes this).
- Cross-company matching of any kind.
- The integration platform (Product B).

## 6. Resolved questions and the design work they imply

All questions were answered on 2026-11-17. Items marked "Design" need a short design note in the module that builds them.

- **Q1, an employee can both drive and ride.** Design: add a server-set `canDrive` capability alongside the existing role. The
  existing `role` claim must keep working for every current rule and function. An employee's driver profile and vehicle reuse the
  existing `drivers` and `vehicles` documents.
- **Q2, free in v1, Stripe off for company rides.** Company-stamped trips skip payment authorization, capture, receipts and
  driver earnings. This is enforced server-side and tested, and consumer payments stay unchanged.
- **Q3, auto-match; the driver may decline within a time limit.** Design: company matches need a "proposed" window before they
  become final. Today the engine commits matches directly, so this adds a new state and timer for company rides only. A decline
  or timeout returns the rider to searching. Consumer matching stays exactly as it is.
- **Q4, no platform approval.** A new company starts `ACTIVE`; platform staff can suspend it.
- **Q5, the company admin verifies their own employee-drivers.** Design: a new company-scoped review function. The existing
  `reviewDriver` and `reviewVehicle` stay ADMIN/SUPER_ADMIN only. A company admin can only see and act on drivers in their own
  company. Risk recorded: this is weaker than the platform-level vetting consumer drivers get. Mitigation: company drivers are
  only ever matched with colleagues, never with consumers.
- **Q6, no recurring commutes.** Single-day rides only in v1.
- **Q7, English-only voice first.** Other languages only after the speech spike shows what devices support.

## 7. Acceptance for Product A

A reviewer can: create a company, invite two employees, have both join; one posts a ride and the other requests it; the
match is proposed and accepted; both get status updates (in-app, push, spoken); the ride completes; the company admin sees
the ride in the dashboard counts, never the exact places; a second company's employees never see or match with any of it;
and every voice action has a working touch equivalent. Each of these is covered by an automated test, and voice is reported separately,
stating exactly what works on which platform.
