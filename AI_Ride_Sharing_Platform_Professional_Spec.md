# AI Ride-Sharing Optimization Platform
## Professional Product & Engineering Specification — Zero to Production

**Project type:** AI-powered dynamic ride-sharing / trip-matching platform  
**Primary goal:** Move the maximum number of people with the minimum number of vehicle trips, while minimizing unnecessary detours, travel time, distance, cost, and emissions.  
**Backend:** Firebase-first architecture  
**Frontend:** Premium mobile experience + operations/admin web dashboard  
**Development method:** Module-by-module, test each module, create a feature branch, merge into `main` only after acceptance  
**Repository:** GitHub  
**Project owner/developer:** Zaira  
**Status:** Greenfield — build from scratch

---

# 1. PRODUCT VISION

This product is not a conventional taxi marketplace whose main objective is to match one passenger with one driver.

It is an **automated transportation optimization network**.

The core idea is:

> A driver is already travelling somewhere. If one or more passengers need transportation along, near, or partially along that route, the system should automatically determine whether they can share that trip with minimal disruption.

The system continuously evaluates:

- active drivers
- driver destinations
- passenger requests
- vehicle capacity
- road networks
- pickup/drop-off points
- route overlap
- travel time
- detour cost
- passenger walking distance
- driver walking/route deviation
- vehicle capacity
- trip priority
- estimated cost
- estimated emissions
- active traffic conditions
- other available shared trips

The system should not simply ask:

> "Which driver is closest?"

It should ask:

> "What combination of existing and new trips transports the most people with the fewest vehicle movements and acceptable inconvenience?"

This is fundamentally an **optimization problem**, supported by AI/ML and real-time routing data.

---

# 2. IMPORTANT PRODUCT PRINCIPLES

## 2.1 Optimization over traditional supply/demand pricing

The platform should not be built around surge pricing.

Pricing is a consequence of the transportation plan, not the mechanism that creates the plan.

The optimization engine should primarily consider:

1. Number of people transported
2. Number of vehicles/trips required
3. Route compatibility
4. Additional distance
5. Additional travel time
6. Passenger walking distance
7. Driver deviation
8. Vehicle capacity
9. Safety constraints
10. Existing active trips
11. Cost
12. Environmental impact

---

## 2.2 "Going that way anyway" model

A driver can voluntarily indicate:

- current position
- intended destination
- departure time
- available seats
- maximum acceptable detour
- vehicle type

The system can then offer compatible passengers whose journeys overlap sufficiently with that driver's intended journey.

The driver does not need to become a traditional taxi driver.

The platform can support:

> "I am already going there. I have spare seats."

---

## 2.3 Flexible destination model

The system should support a **mobility corridor** rather than forcing every passenger to receive door-to-door transportation.

Example:

Passenger requests:

`A → B`

The optimizer may determine:

`A → Main Street near B`

Then:

- passenger walks the remaining distance
- another shared ride continues toward B
- or passenger books a normal taxi for the final segment

The system should make the trade-off explicit.

---

# 3. CRITICAL RULE: PASSENGER CONSENT

The optimization engine may propose changes, but it must not silently violate a passenger's agreed constraints.

Every passenger request must contain a flexibility profile:

```text
maximum_walk_distance
maximum_extra_time
maximum_route_deviation
allow_shared_ride
allow_route_change
allow_additional_passengers
preferred_arrival_time
hard_arrival_deadline
```

A passenger can choose:

### Strict
No meaningful route changes.

### Balanced
Allow reasonable walking and route changes.

### Flexible
Allow significant shared routing if it reduces cost/time/environmental impact.

This allows the system to automate decisions while preserving clear user-defined limits.

---

# 4. DYNAMIC RE-OPTIMIZATION

A key feature is dynamic insertion.

Example:

Driver:

`Home → Office`

Passenger A:

`Point X → Office`

The system assigns Passenger A.

While the vehicle is travelling, Passenger B requests:

`Point Y → Point Z`

The optimizer checks:

- Can B board without violating capacity?
- Does B's route overlap?
- Can A be dropped at a new practical point?
- Does A's flexibility permit it?
- Is the additional travel acceptable?
- Is there another vehicle available for B?
- Is re-optimization beneficial globally?

If the answer satisfies all constraints, the system can generate a revised plan.

However:

**The engine must never silently change an already accepted hard constraint.**

If a change affects a passenger's protected constraints, the system must request confirmation or find another feasible plan.

---

# 5. SYSTEM ACTORS

## Passenger

Can:

- create a trip request
- choose destination
- choose flexibility
- view assigned pickup
- view assigned drop-off
- see walking instructions
- track vehicle
- pay automatically
- receive receipt
- rate/report trip

---

## Driver / Vehicle Owner

Can:

- create account
- verify identity
- add vehicle
- declare destination
- declare available seats
- set departure time
- set maximum detour
- accept automatic participation
- view assigned passengers
- navigate route
- receive earnings
- see trip history

---

## Operations/Admin

Can:

- monitor network
- view active trips
- inspect optimization decisions
- manage users
- manage drivers
- manage vehicles
- manage payments
- manage disputes
- view system metrics
- configure optimization constraints
- view system health
- audit automated decisions

---

# 6. HIGH-LEVEL ARCHITECTURE

```text
                    ┌───────────────────────┐
                    │ Passenger Mobile App  │
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │ Driver Mobile App     │
                    └───────────┬───────────┘
                                │
                         Firebase Auth
                                │
                    ┌───────────▼───────────┐
                    │ Firestore Database    │
                    └───────────┬───────────┘
                                │
                    Firebase Cloud Functions
                                │
             ┌──────────────────┼──────────────────┐
             │                  │                  │
             ▼                  ▼                  ▼
       Trip Service       Payment Service    Notification
             │
             ▼
       Optimization API
        / AI Engine
             │
      ┌──────┼──────────┐
      ▼      ▼          ▼
   Maps API  ML      OR-Tools
   Routing   Models   Optimization
```

---

# 7. RECOMMENDED TECHNOLOGY STACK

## Frontend

### Mobile
**React Native + Expo + TypeScript**

Reason:

- iOS + Android
- strong ecosystem
- fast development
- excellent maps support
- push notifications
- location services
- reusable components

Applications:

```text
Passenger App
Driver App
```

---

## Admin Web

**Next.js + TypeScript + Tailwind CSS**

Admin dashboard should be desktop-first and highly polished.

---

## Backend

### Firebase

Use:

- Firebase Authentication
- Cloud Firestore
- Cloud Functions
- Firebase Cloud Messaging
- Firebase Storage
- Firebase App Check
- Firebase Analytics
- Firebase Crashlytics where applicable
- Firebase Remote Config where useful

---

## Optimization Engine

Do NOT attempt to solve the entire optimization problem with an LLM.

Use deterministic optimization + AI/ML.

Recommended:

**Python + FastAPI + Google OR-Tools**

Potential components:

- Vehicle Routing Problem
- Capacitated Vehicle Routing
- Dynamic Ride Sharing
- Pickup and Delivery Problem
- Constraint Programming
- mixed integer optimization where appropriate

---

## AI/ML Layer

AI can be used for:

- demand forecasting
- ETA prediction
- route feasibility prediction
- cancellation prediction
- trip clustering
- demand heatmaps
- dynamic optimization
- anomaly detection
- travel-time prediction

LLMs are optional and should never control safety-critical routing logic directly.

---

# 8. MAPS & ROUTING

Recommended:

**Google Maps Platform**

Potential APIs:

- Maps SDK
- Routes API
- Geocoding
- Places
- Navigation-related services as appropriate
- traffic-aware routing

The application should work with coordinates rather than relying only on addresses.

Every important location should store:

```text
latitude
longitude
formatted_address
place_id
```

---

# 9. PAYMENT ARCHITECTURE

Recommended:

**Stripe**

Potential flow:

```text
Passenger creates request
        ↓
Trip estimated
        ↓
Payment method authorized
        ↓
Trip completed
        ↓
Final fare calculated
        ↓
Payment captured
        ↓
Driver earnings calculated
        ↓
Platform fee calculated
        ↓
Receipt generated
```

Use Stripe's supported marketplace/connect functionality if the legal/business model requires driver payouts.

Never store raw card details in Firestore.

---

# 10. CORE DOMAIN MODEL

## User

```text
users/{userId}

role
name
email
phone
photoUrl
status
createdAt
updatedAt
```

---

## Driver Profile

```text
drivers/{driverId}

userId
verificationStatus
availabilityStatus
rating
totalTrips
maxDetourMinutes
maxDetourDistance
automaticMatchingEnabled
createdAt
updatedAt
```

---

## Vehicle

```text
vehicles/{vehicleId}

driverId
type
make
model
plateNumber
seatCapacity
availableSeats
verificationStatus
```

---

## Trip Request

```text
tripRequests/{tripId}

passengerId
origin
destination

requestedAt
requestedDepartureTime
arrivalDeadline

status

passengerPreferences:
  maxWalkingDistance
  maxExtraTime
  maxDetourDistance
  allowSharedRide
  allowRouteChange
  flexibilityLevel

estimatedFare
estimatedDistance
estimatedDuration

assignedPlanId

createdAt
updatedAt
```

---

## Driver Journey

```text
driverJourneys/{journeyId}

driverId
vehicleId
origin
destination
departureTime

availableSeats

maxDetourMinutes
maxDetourDistance

status

currentLocation
currentRoute

createdAt
updatedAt
```

---

## Shared Trip Plan

This is one of the most important entities.

```text
sharedTripPlans/{planId}

vehicleId
driverId

passengers[]

orderedStops[]

routePolyline

totalDistance
totalDuration

baselineDistance
baselineDuration

additionalDistance
additionalDuration

optimizationScore

environmentalEstimate

status

version
createdAt
updatedAt
```

---

# 11. STOP MODEL

Each route stop:

```text
stopId
type
passengerId
location
sequence
estimatedArrival
estimatedDeparture
walkingDistance
status
```

Types:

```text
PICKUP
DROPOFF
DRIVER_ORIGIN
DRIVER_DESTINATION
```

The system can dynamically reorder stops when allowed.

---

# 12. OPTIMIZATION ENGINE

This is the heart of the product.

The optimizer receives:

```text
active drivers
active journeys
open passenger requests
vehicles
routes
traffic
constraints
pricing rules
system configuration
```

It produces:

```text
vehicle assignments
passenger assignments
pickup points
drop-off points
stop ordering
route
estimated times
estimated cost
optimization metrics
```

---

# 13. OPTIMIZATION OBJECTIVE

Use a weighted objective rather than a simplistic nearest-driver algorithm.

Example conceptual objective:

```text
MINIMIZE

vehicle_count
+ distance_cost
+ time_cost
+ passenger_walk_cost
+ driver_detour_cost
+ missed_deadline_penalty
+ empty_seat_penalty
+ environmental_cost
+ operational_cost
```

Subject to:

```text
vehicle capacity
driver destination constraints
passenger constraints
maximum walking distance
maximum detour
time windows
arrival deadlines
route feasibility
safety constraints
vehicle eligibility
payment validity
```

The exact weights must be configurable.

Do not hard-code them throughout the application.

---

# 14. OPTIMIZATION SCORE

Every generated plan should have an internal explainable score.

Example:

```text
Vehicle reduction:       +40
Passenger compatibility: +25
Low detour:              +20
Low walking:             +10
Low emissions:            +5
------------------------------
Total:                   100
```

These values are examples only.

The production optimizer must use configurable weights.

Admin should be able to inspect:

```text
Why was this passenger assigned?
Why was this route selected?
Why was another route rejected?
What constraint prevented a match?
```

This is essential for debugging and trust.

---

# 15. MATCHING PIPELINE

## Stage 1 — Candidate Discovery

Find potentially compatible drivers using:

- geospatial proximity
- route corridor
- departure window
- available seats
- destination direction

Do not run expensive optimization against every vehicle in the city.

---

## Stage 2 — Route Compatibility

Calculate:

```text
route overlap
pickup deviation
drop-off deviation
additional distance
additional duration
walking distance
```

---

## Stage 3 — Constraint Filtering

Remove candidates violating hard constraints.

---

## Stage 4 — Optimization

Run OR-Tools / optimization engine on remaining candidates.

---

## Stage 5 — Plan Validation

Validate:

- capacity
- times
- routes
- walking distances
- safety rules
- payment status
- driver eligibility

---

## Stage 6 — Assignment

Create a versioned `sharedTripPlan`.

---

## Stage 7 — Real-Time Monitoring

Continuously monitor:

- GPS
- traffic
- delays
- cancellations
- new requests
- vehicle capacity
- route deviation

---

# 16. REAL-TIME RE-OPTIMIZATION

Re-run optimization when meaningful events occur.

Examples:

```text
NEW_PASSENGER_REQUEST
DRIVER_CANCELLATION
PASSENGER_CANCELLATION
TRAFFIC_CHANGE
SIGNIFICANT_DELAY
DRIVER_ROUTE_CHANGE
CAPACITY_CHANGE
PASSENGER_NO_SHOW
VEHICLE_PROBLEM
```

Do not continuously re-optimize every second.

Use an event-driven strategy.

---

# 17. PLAN VERSIONING

Never overwrite an accepted route blindly.

Use:

```text
planVersion: 1
planVersion: 2
planVersion: 3
```

Each version stores:

```text
createdAt
trigger
previousVersion
changedStops
changedPassengers
changedRoute
reason
```

This creates a complete audit trail.

---

# 18. PASSENGER EXPERIENCE

## Passenger flow

```text
Open app
 ↓
Enter destination
 ↓
Select pickup point
 ↓
Choose flexibility
 ↓
Request trip
 ↓
System searches network
 ↓
System creates optimal shared plan
 ↓
Passenger sees:
  pickup point
  drop-off point
  walking distance
  ETA
  estimated price
  sharing information
 ↓
Payment authorization
 ↓
Trip begins
 ↓
Live tracking
 ↓
Dynamic updates if necessary
 ↓
Trip completed
 ↓
Payment finalized
 ↓
Receipt
```

---

# 19. DRIVER EXPERIENCE

```text
Open Driver App
 ↓
Go Online
 ↓
Enter destination
 ↓
Set available seats
 ↓
Set maximum detour
 ↓
System searches passengers
 ↓
AI generates optimized journey
 ↓
Driver receives route
 ↓
Navigation starts
 ↓
Passenger pickup
 ↓
Passenger drop-off
 ↓
Possible dynamic re-optimization
 ↓
Journey complete
 ↓
Earnings updated
```

---

# 20. DRIVER SAFETY

The driver should not interact with complicated UI while driving.

When navigation is active:

- large controls
- minimal text
- voice prompts
- limited interaction
- no unnecessary notifications
- automatic route updates

Never require the driver to manually type while moving.

---

# 21. PASSENGER SAFETY

Include:

- verified driver indicator
- vehicle information
- emergency action
- trip sharing
- live trip tracking
- report issue
- support
- trip history

Emergency functionality must be designed according to the target country's legal requirements.

---

# 22. ADMIN DASHBOARD

Create a premium operations center.

Pages:

```text
Overview
Live Network
Trips
Drivers
Passengers
Vehicles
Optimization
Payments
Disputes
Safety
Analytics
System Settings
Audit Logs
```

---

# 23. LIVE NETWORK DASHBOARD

Display:

```text
Active vehicles
Active passengers
Open requests
Shared trips
Unmatched requests
Average occupancy
Vehicles saved
Estimated emissions saved
Current network efficiency
```

Map:

- active vehicles
- active routes
- pickup points
- drop-off points
- high-demand areas
- unmatched requests

---

# 24. OPTIMIZATION CONTROL CENTER

Admin should be able to inspect the optimizer.

Show:

```text
Optimization cycle ID
Time started
Requests evaluated
Drivers evaluated
Candidates generated
Plans generated
Plans rejected
Constraints triggered
Final assignments
Execution time
```

For each decision:

```text
Passenger A
Driver B
Compatibility: 94%
Additional distance: 1.4 km
Additional time: 4 min
Passenger walking: 250 m
Seats used: 2/4
Reason accepted: route overlap + low detour
```

---

# 25. FIREBASE SECURITY

Use Firebase Authentication + Firestore Security Rules.

Rules must ensure:

Passenger:

- can read own profile
- can read own trips
- can read assigned driver/trip information
- cannot modify optimization decisions
- cannot access other passenger data

Driver:

- can read own driver profile
- can read assigned trips
- can update permitted location/status data
- cannot alter payment records

Admin:

- elevated access through secure server-side role verification

Never trust a client-side role field.

---

# 26. ROLE-BASED ACCESS CONTROL

Roles:

```text
PASSENGER
DRIVER
SUPPORT
OPERATIONS
ADMIN
SUPER_ADMIN
```

Use Firebase custom claims where appropriate.

Server-side authorization is mandatory.

---

# 27. FIRESTORE COLLECTION STRUCTURE

Recommended initial structure:

```text
users
drivers
vehicles
tripRequests
driverJourneys
sharedTripPlans
tripEvents
payments
earnings
notifications
supportTickets
auditLogs
systemConfig
optimizationRuns
```

Subcollections may be introduced where they improve data locality.

Do not create an unnecessarily complex schema.

---

# 28. CLOUD FUNCTIONS

Use Cloud Functions for event-driven backend workflows.

Examples:

```text
onTripRequestCreated
onTripRequestUpdated
onDriverJourneyCreated
onDriverLocationUpdated
onTripCompleted
onTripCancelled
onPaymentAuthorized
onPaymentCompleted
onDriverStatusChanged
onOptimizationRequested
```

Functions should remain small and responsibility-focused.

---

# 29. OPTIMIZATION SERVICE

For heavy optimization, use a dedicated Python service.

Recommended:

```text
FastAPI
OR-Tools
Pydantic
Redis optional
Docker
Cloud Run
```

Firebase Cloud Functions should orchestrate the system.

Cloud Run should perform computationally expensive optimization.

---

# 30. ASYNC JOB ARCHITECTURE

Example:

```text
Trip request created
        ↓
Cloud Function
        ↓
Optimization Job
        ↓
Cloud Run Optimization API
        ↓
Candidate generation
        ↓
Constraint filtering
        ↓
OR-Tools optimization
        ↓
Validation
        ↓
Firestore plan
        ↓
FCM notification
```

For high scale, add:

```text
Cloud Tasks
Pub/Sub
```

only when required.

Do not over-engineer the MVP.

---

# 31. AI LAYER

AI should solve real problems.

Potential ML models:

### ETA prediction

Inputs:

```text
historical travel time
time of day
day of week
weather if legally/technically appropriate
traffic
road type
distance
```

### Demand prediction

Predict:

```text
where requests are likely to appear
when requests will appear
expected demand intensity
```

### Cancellation prediction

Estimate cancellation risk.

### Route compatibility model

Estimate likelihood that two journeys can be combined.

---

# 32. AI VS OPTIMIZATION

This distinction is mandatory.

Use:

### AI/ML for prediction

Examples:

- ETA
- demand
- cancellation
- travel-time patterns

Use:

### Optimization algorithms for decisions

Examples:

- who rides with whom
- pickup sequence
- drop-off sequence
- vehicle assignment
- route modification

Use:

### LLM only where it adds value

Examples:

- support assistant
- admin explanations
- natural-language operational queries
- incident summaries

Do NOT allow an LLM to freely invent routes or override hard safety constraints.

---

# 33. ENVIRONMENTAL METRICS

The system should estimate:

```text
vehicles avoided
distance avoided
estimated fuel avoided
estimated CO2 avoided
average occupancy
shared-trip percentage
```

These should be labeled as estimates.

Do not claim exact emissions unless verified with appropriate methodology/data.

---

# 34. ECONOMIC MODEL

Possible fare model:

```text
base trip cost
+
shared-trip adjustment
+
distance/time component
-
shared efficiency benefit
```

Driver earnings:

```text
trip revenue
-
platform fee
=
driver payout
```

The exact commercial model must be configurable.

Do not build business logic around a hard-coded commission percentage.

---

# 35. PRICING SHOULD NOT DRIVE MATCHING

The matching engine must not deliberately create poor routes simply because they produce a higher fare.

Matching happens first based on transportation feasibility and system objectives.

Pricing happens after the feasible trip plan is established.

---

# 36. WALKING-BASED LAST MILE

A core capability.

The system can suggest:

```text
Vehicle drop-off
        ↓
Passenger walks 350m
        ↓
Destination
```

If the distance is acceptable according to the passenger's settings, the system can use this to improve network efficiency.

The UI must show:

```text
Walk 350m
Estimated 5 min
```

before the passenger commits to the plan.

---

# 37. MULTI-LEG TRIPS

Future capability:

```text
Shared ride
   ↓
Main road
   ↓
Second shared ride
   ↓
Walking
   ↓
Destination
```

This could become one of the most powerful parts of the system.

However, MVP should start with single-vehicle shared trips.

Multi-leg routing should be Phase 2/3.

---

# 38. CANCELLATIONS

Passenger cancellation:

```text
request cancellation
 ↓
payment adjustment
 ↓
re-optimize affected journey
```

Driver cancellation:

```text
driver cancellation
 ↓
identify affected passengers
 ↓
find replacement journey
 ↓
re-optimize
 ↓
notify passengers
```

---

# 39. NO-SHOW HANDLING

Driver/passenger GPS and trip events can determine probable no-show situations.

Do not automatically penalize users based only on GPS.

Use a defined event sequence:

```text
arrived
waiting
contact attempt
grace period
no-show
resolution
```

Keep an audit record.

---

# 40. NOTIFICATION SYSTEM

Firebase Cloud Messaging.

Notification types:

```text
Trip requested
Trip matched
Pickup changed
Drop-off changed
Driver arriving
Passenger pickup
Trip started
Trip updated
Trip completed
Payment successful
Payment failed
Cancellation
Safety alert
Support response
```

Notifications should be actionable and minimal.

---

# 41. FRONTEND DESIGN DIRECTION

The UI should feel like a serious global mobility product.

Avoid:

- cheap taxi-app appearance
- excessive gradients
- excessive glassmorphism
- cartoonish illustrations
- clutter
- unnecessary animations

Design direction:

### Primary palette

```text
Midnight Navy
#0B1220

Deep Slate
#172033

Clean White
#F8FAFC

Electric Cyan
#22D3EE

Emerald
#10B981

Amber
#F59E0B

Danger Red
#EF4444
```

Use colors semantically.

---

# 42. VISUAL IDENTITY

The product should communicate:

```text
Intelligence
Movement
Efficiency
Trust
Technology
Sustainability
```

Use:

- clean typography
- strong spacing
- map-first interface
- subtle motion
- premium cards
- clear route visualization
- excellent empty states
- excellent loading states

---

# 43. PASSENGER HOME SCREEN

Main elements:

```text
Where are you going?

[ Search destination ]

Current location

Quick destinations

Recent trips

Active trip card
```

Map should occupy a large portion of the interface.

---

# 44. TRIP REQUEST SCREEN

Display:

```text
Pickup
Destination

Estimated time
Estimated walking
Estimated fare

Sharing:
[ Flexible ]

Maximum walking:
[ 500m ]

Maximum extra time:
[ 10 min ]

[ Find Ride ]
```

---

# 45. MATCH RESULT

Show the plan visually:

```text
You
 ↓
Pickup Point
 ↓
Passenger A
 ↓
Main Road
 ↓
Drop-off
 ↓
Walk 300m
 ↓
Destination
```

Explain why the system selected it.

Example:

> "This route shares 72% of the journey and adds approximately 4 minutes."

---

# 46. DRIVER HOME SCREEN

Show:

```text
GO ONLINE

Destination:
Office

Available seats:
3

Maximum detour:
10 min

Automatic matching:
ON
```

When a match is generated:

```text
2 passengers can join your route.

Additional distance:
1.2 km

Estimated additional time:
4 min

Estimated earnings:
£X
```

---

# 47. ADMIN UI DESIGN

Dark operational dashboard can be used.

Layout:

```text
Sidebar
Top status bar
Main analytics
Live map
Optimization panel
Activity feed
```

Use charts sparingly.

Important metrics should be immediately visible.

---

# 48. REAL-TIME MAP

Map markers:

```text
Driver
Passenger pickup
Passenger destination
Shared route
Unmatched request
```

Use marker clustering for scale.

---

# 49. MOBILE NAVIGATION

Passenger:

```text
Home
Trips
Wallet
Profile
```

Driver:

```text
Home
Current Journey
Earnings
History
Profile
```

---

# 50. PROJECT STRUCTURE

Recommended monorepo:

```text
ride-sharing-platform/

apps/
  passenger/
  driver/
  admin/

services/
  optimizer/

functions/

packages/
  ui/
  types/
  config/
  firebase/
  maps/
  payments/

docs/

tests/

scripts/
```

---

# 51. TYPESCRIPT STANDARDS

Strict TypeScript.

Use:

```text
noImplicitAny
strict
strictNullChecks
```

Never use `any` unless there is a documented reason.

Create shared domain types.

---

# 52. API / SERVICE CONTRACTS

Every backend service must have explicit contracts.

Example:

```typescript
TripRequest
DriverJourney
SharedTripPlan
OptimizationCandidate
OptimizationResult
Payment
```

Use validation schemas.

Recommended:

**Zod**

Frontend and backend should share validation where practical.

---

# 53. ERROR HANDLING

Every important operation needs:

```text
success
loading
empty
validation error
network error
server error
permission error
timeout
retry
```

Do not show raw technical errors to users.

Log technical details securely.

---

# 54. OBSERVABILITY

Track:

```text
optimization latency
matching success rate
unmatched requests
average occupancy
average detour
average walking distance
payment failures
API errors
Cloud Function failures
route calculation failures
```

Create correlation IDs:

```text
requestId
tripId
optimizationRunId
planId
```

---

# 55. AUDIT LOGGING

Every important automated decision should be auditable.

Example:

```text
timestamp
actor
action
entity
previousState
newState
reason
optimizationRunId
```

Never store unnecessary sensitive information.

---

# 56. DATA PRIVACY

Location data is highly sensitive.

Requirements:

- minimum necessary data collection
- clear consent
- secure access
- encrypted transport
- strict Firestore rules
- retention policies
- deletion workflows
- audit logging
- privacy policy
- applicable data protection compliance

The final legal implementation must be reviewed for the launch jurisdiction.

---

# 57. SECURITY

Implement:

```text
Firebase Auth
App Check
Firestore Rules
Cloud Functions authorization
Custom claims
rate limiting
input validation
API key restrictions
secret management
payment webhook verification
server-side authorization
```

Never put privileged Firebase credentials in the client.

---

# 58. FRAUD PROTECTION

Future/production capabilities:

```text
GPS spoof detection
impossible travel detection
payment anomaly detection
account duplication detection
driver/passenger abuse detection
repeated cancellation detection
```

These should flag cases for review rather than automatically punishing users without defined rules.

---

# 59. TESTING STRATEGY

## Unit Tests

Test:

- fare calculations
- constraint checks
- walking distance limits
- capacity rules
- route scoring
- optimization objective
- payment calculations

---

## Integration Tests

Test:

```text
Passenger → Trip Request
Trip Request → Optimization
Optimization → Shared Plan
Shared Plan → Notification
Trip → Payment
Trip Completion → Earnings
```

---

## E2E Tests

Use:

**Playwright**

For admin web.

For mobile, use appropriate Expo/React Native testing and device automation.

---

# 60. OPTIMIZATION TEST DATA

Create deterministic scenarios.

### Scenario A

```text
1 driver
1 passenger
```

Expected:

direct compatible trip.

### Scenario B

```text
1 driver
2 passengers
```

Expected:

shared trip if constraints permit.

### Scenario C

```text
1 driver
3 passengers
vehicle capacity = 4
```

Expected:

multi-passenger route.

### Scenario D

Passenger is incompatible because walking distance exceeds limit.

Expected:

candidate rejected.

### Scenario E

Passenger cannot be added without violating an existing hard constraint.

Expected:

existing trip preserved.

### Scenario F

New passenger makes a better global solution.

Expected:

re-optimization generates a new plan only if all protected constraints remain valid.

---

# 61. DEVELOPMENT PHASES

The project must be built module-by-module.

Do not attempt to build everything at once.

---

# PHASE 0 — FOUNDATION

Modules:

1. Repository setup
2. Project documentation
3. Firebase project
4. Environment configuration
5. GitHub setup
6. CI basics
7. Shared TypeScript configuration
8. Design system foundation

Acceptance:

- projects run locally
- Firebase connects
- environment variables work
- Git branches work
- linting works
- formatting works
- tests run

---

# PHASE 1 — AUTHENTICATION & USERS

Modules:

1. Firebase Auth
2. Registration
3. Login
4. Logout
5. Password reset
6. Profile
7. Role system
8. Firestore security rules

Acceptance:

- Passenger can register
- Driver can register
- Admin role is protected
- unauthorized access is blocked

---

# PHASE 2 — DRIVER & VEHICLE

Modules:

1. Driver profile
2. Vehicle profile
3. Vehicle capacity
4. Driver verification status
5. Availability
6. Destination declaration
7. Seat availability
8. Maximum detour settings

Acceptance:

Driver can create a valid journey.

---

# PHASE 3 — PASSENGER TRIP REQUEST

Modules:

1. Location search
2. Map
3. Pickup
4. Destination
5. Time preferences
6. Flexibility settings
7. Trip request creation
8. Trip status

Acceptance:

Passenger can create a complete request.

---

# PHASE 4 — GEOLOCATION & ROUTING

Modules:

1. GPS
2. Geocoding
3. Route calculation
4. Distance calculation
5. ETA
6. Walking routes
7. Route polyline

Acceptance:

The system can calculate realistic routes.

---

# PHASE 5 — BASIC MATCHING ENGINE

Start simple.

Implement:

```text
geospatial candidate discovery
+
capacity
+
departure compatibility
+
route overlap
+
walking distance
+
detour constraints
```

Acceptance:

The system can automatically match simple shared trips.

---

# PHASE 6 — OPTIMIZATION ENGINE

Build Python service.

Modules:

1. Candidate generation
2. Constraint engine
3. OR-Tools model
4. Objective function
5. Plan generation
6. Plan validation
7. Explainability
8. Optimization run logging

Acceptance:

Multiple passengers can be assigned to a shared route automatically.

---

# PHASE 7 — REAL-TIME TRIPS

Modules:

1. Driver location
2. Passenger tracking
3. Trip events
4. Live map
5. ETA updates
6. Stop status
7. Trip state machine

Acceptance:

A complete shared trip can be followed in real time.

---

# PHASE 8 — DYNAMIC RE-OPTIMIZATION

Modules:

1. Event detection
2. Optimization trigger
3. Plan versioning
4. New passenger insertion
5. Driver cancellation
6. Traffic delay
7. Route modification
8. Passenger constraint validation
9. Notification

Acceptance:

The system can safely modify feasible trips when network conditions change.

---

# PHASE 9 — PAYMENTS

Modules:

1. Stripe integration
2. Payment authorization
3. Fare calculation
4. Payment capture
5. Driver earnings
6. Platform fee
7. Refunds
8. Receipts
9. Webhooks

Acceptance:

Complete trip → automatic payment → earnings record.

---

# PHASE 10 — NOTIFICATIONS

Modules:

1. FCM
2. Push tokens
3. Trip notifications
4. Route changes
5. Driver arrival
6. Payment notifications
7. Safety notifications

---

# PHASE 11 — ADMIN OPERATIONS

Modules:

1. Dashboard
2. Live map
3. User management
4. Driver management
5. Vehicle management
6. Trip monitoring
7. Optimization monitoring
8. Payments
9. Disputes
10. Audit logs

---

# PHASE 12 — ANALYTICS

Metrics:

```text
Trips completed
People transported
Vehicles used
Average occupancy
Vehicle trips avoided
Average detour
Average passenger walking distance
Average matching time
Unmatched requests
Cancellation rate
Payment success rate
Estimated emissions avoided
```

---

# PHASE 13 — AI/ML

Add ML only after reliable operational data exists.

Modules:

1. ETA model
2. Demand prediction
3. Cancellation prediction
4. Route compatibility prediction
5. Network forecasting

---

# PHASE 14 — PRODUCTION HARDENING

Modules:

1. Security audit
2. Performance
3. Load testing
4. Failure recovery
5. Monitoring
6. Backup strategy
7. Privacy compliance
8. Payment compliance
9. App store preparation
10. Production deployment

---

# 62. GIT WORKFLOW

This is mandatory.

Never develop everything directly on `main`.

Branches:

```text
main
develop

feature/auth
feature/driver
feature/passenger
feature/routing
feature/matching
feature/optimizer
feature/realtime
feature/payments
feature/notifications
feature/admin
feature/analytics
feature/ml
```

---

# 63. MODULE WORKFLOW

For every module:

```text
1. Read specification
2. Inspect existing code
3. Create feature branch
4. Implement module
5. Run lint
6. Run tests
7. Fix errors
8. Verify UI
9. Verify backend
10. Verify Firebase rules
11. Update documentation
12. Commit
13. Push branch
14. Review
15. Merge into develop
16. Verify integration
17. Merge into main when accepted
```

Do not move to the next major module when the current module is broken.

---

# 64. COMMIT CONVENTION

Use:

```text
feat:
fix:
refactor:
test:
docs:
chore:
security:
```

Examples:

```text
feat: add passenger trip request flow
feat: implement route candidate generation
feat: add shared trip optimizer
fix: prevent invalid passenger assignment
test: add capacity constraint tests
```

---

# 65. PULL REQUEST TEMPLATE

Every PR should contain:

```text
## What changed

## Why

## Module

## Backend changes

## Frontend changes

## Firebase changes

## Tests

## Screenshots

## Known limitations

## Security considerations
```

---

# 66. CLAUDE CODE / AI CODING AGENT RULES

The coding agent must follow these rules:

1. Read the project specification before coding.
2. Inspect the existing repository before modifying anything.
3. Never hallucinate missing requirements.
4. Never invent API credentials.
5. Never invent Firebase configuration.
6. Never overwrite working code without understanding it.
7. Work module-by-module.
8. Keep changes scoped to the current module.
9. Ask the developer when a requirement is ambiguous.
10. Do not silently make product decisions that affect core behavior.
11. Do not expose coding-agent branding in the product UI.
12. Do not add unnecessary dependencies.
13. Do not replace Firebase with another backend unless explicitly approved.
14. Do not use mock data as a permanent implementation.
15. Replace temporary mocks with real integrations before module completion.
16. Run tests after meaningful changes.
17. Run lint/type checks.
18. Update documentation.
19. Commit to the feature branch.
20. Push the branch.
21. Do not merge without verification.
22. Keep the Git working tree clean after a completed module.

---

# 67. ANTI-HALLUCINATION RULE

If something is unclear:

**STOP AND ASK.**

Do not assume:

- business rules
- pricing rules
- Firebase structure
- API behavior
- legal requirements
- optimization weights
- passenger consent
- driver behavior
- payment behavior

Questions are preferable to fabricated implementation.

---

# 68. NO PLACEHOLDER PRODUCT LOGIC

The following must not remain fake in the final implementation:

```text
fake matching
fake payment success
fake driver location
fake optimization
fake route calculation
fake earnings
fake Firebase calls
```

Mocks are acceptable only for isolated development/testing and must be clearly marked.

---

# 69. PERFORMANCE TARGETS

Initial engineering targets:

```text
Trip request creation: < 1 second excluding external APIs
Candidate discovery: low-latency
Simple matching: near real-time
Optimization: target seconds, not minutes
Realtime location updates: efficient and throttled
Admin map: responsive with large datasets
```

Actual targets should be validated through load testing.

---

# 70. SCALABILITY STRATEGY

Initial:

```text
Firebase
Cloud Functions
Cloud Run
Firestore
FCM
Google Maps
Stripe
```

Later:

```text
Pub/Sub
Cloud Tasks
Redis
BigQuery
data warehouse
specialized optimization infrastructure
```

Do not introduce these before the product needs them.

---

# 71. FIRESTORE SCALABILITY NOTES

Avoid:

- excessive writes
- constantly writing GPS every second
- unbounded queries
- massive documents
- deeply nested structures
- client-side trust

Use:

- throttled location updates
- indexes
- pagination
- aggregation
- event-driven writes
- archival strategies

---

# 72. LOCATION UPDATE STRATEGY

Do not write GPS to Firestore every second.

Use adaptive updates.

Example concept:

```text
high movement:
more frequent

low movement:
less frequent

trip inactive:
minimal/no updates
```

The exact interval should be configurable and tested.

---

# 73. TRIP STATE MACHINE

Use explicit states.

Passenger:

```text
REQUESTED
SEARCHING
MATCHED
PICKUP_ASSIGNED
DRIVER_ARRIVING
PICKED_UP
IN_TRANSIT
DROPOFF_APPROACHING
COMPLETED
CANCELLED
```

Driver journey:

```text
DRAFT
AVAILABLE
MATCHING
ACTIVE
PAUSED
COMPLETED
CANCELLED
```

Do not allow arbitrary state transitions.

---

# 74. PAYMENT STATE MACHINE

```text
PENDING
AUTHORIZED
CAPTURED
FAILED
REFUNDED
PARTIALLY_REFUNDED
DISPUTED
```

Payment state must be server-authoritative.

---

# 75. CORE DATABASE INDEXES

Create indexes based on actual query patterns.

Likely fields:

```text
tripRequests.status
tripRequests.requestedDepartureTime
tripRequests.passengerId

driverJourneys.status
driverJourneys.departureTime
driverJourneys.driverId

sharedTripPlans.status
sharedTripPlans.driverId

optimizationRuns.createdAt
```

Geo queries should use a tested geospatial strategy.

---

# 76. MVP DEFINITION

The MVP should prove the central idea.

MVP must support:

```text
Passenger
Driver
Firebase Auth
Map
Trip request
Driver destination
Available seats
Basic route calculation
Automatic candidate matching
Shared route
Pickup/drop-off assignment
Realtime trip state
Basic payment
Basic notifications
Admin live trip monitoring
Optimization logs
```

MVP does NOT need:

```text
advanced ML
multi-leg transport
global-scale infrastructure
complex AI chatbot
social features
loyalty system
gamification
```

---

# 77. DEMO SCENARIO

Create a controlled city simulation.

Example:

```text
10 drivers
25 passengers
multiple destinations
vehicle capacities 2–6
```

The dashboard should demonstrate:

```text
Before optimization:
25 passenger requests
potentially many individual trips

After optimization:
shared routes
higher occupancy
fewer vehicle movements
```

Use simulation data for demos.

Clearly label it as simulated data.

---

# 78. SUCCESS METRICS

The platform should measure:

### Transportation efficiency

```text
people / vehicle
vehicle trips / passenger
shared trip percentage
vehicle kilometers
```

### User experience

```text
average walking distance
average additional time
cancellation rate
successful completion rate
```

### Economic

```text
average passenger cost
driver earnings
platform revenue
cost per passenger
```

### Environmental

```text
estimated vehicle trips avoided
estimated distance avoided
estimated emissions avoided
```

---

# 79. IMPORTANT BUSINESS REALITY

This platform is more than a normal ride-sharing app.

The difficult engineering problem is not the map or mobile UI.

The core challenge is:

> **Real-time constrained optimization of a moving transportation network.**

Therefore engineering effort should be concentrated on:

1. Data quality
2. Routing
3. Constraint modeling
4. Optimization
5. Real-time events
6. Safety
7. Payment correctness
8. Scalability
9. Observability

---

# 80. FINAL PRODUCT STANDARD

The finished product should feel like a serious mobility technology company, not a student demo.

Required qualities:

- polished mobile UI
- excellent maps
- fast interactions
- real Firebase backend
- real-time data
- real payment integration
- real optimization service
- secure authorization
- clean architecture
- strong testing
- detailed audit trail
- production-grade error handling
- responsive admin dashboard
- professional Git history
- clear documentation

---

# 81. BUILD ORDER

The exact initial build sequence is:

```text
PHASE 0
Foundation

↓
PHASE 1
Authentication

↓
PHASE 2
Driver + Vehicle

↓
PHASE 3
Passenger Requests

↓
PHASE 4
Maps + Routing

↓
PHASE 5
Basic Matching

↓
PHASE 6
Optimization Engine

↓
PHASE 7
Realtime Trips

↓
PHASE 8
Dynamic Re-Optimization

↓
PHASE 9
Payments

↓
PHASE 10
Notifications

↓
PHASE 11
Admin

↓
PHASE 12
Analytics

↓
PHASE 13
AI/ML

↓
PHASE 14
Production
```

---

# 82. DEFINITION OF DONE

A module is complete only when:

```text
[ ] Feature implemented
[ ] UI complete
[ ] Backend complete
[ ] Firebase integration complete
[ ] Security rules verified
[ ] Validation implemented
[ ] Error states implemented
[ ] Loading states implemented
[ ] Tests written
[ ] Tests passing
[ ] Lint passing
[ ] TypeScript passing
[ ] Documentation updated
[ ] No unexplained TODOs
[ ] No permanent mock logic
[ ] Feature branch committed
[ ] Branch pushed to GitHub
[ ] PR reviewed
[ ] Merged into develop
[ ] Integration verified
```

---

# 83. FIRST TASK

Do not start by building the entire application.

Start with:

## Module 0.1 — Repository & Architecture Foundation

First inspect the repository.

Then create:

```text
apps/
services/
functions/
packages/
docs/
tests/
```

Set up:

- TypeScript
- linting
- formatting
- environment management
- Firebase configuration structure
- Git branches
- README
- architecture documentation
- design tokens
- base navigation
- shared types

Then stop and report:

```text
Completed:
Files changed:
Tests:
Lint:
Type check:
Git branch:
Commit:
Next module:
Questions/blockers:
```

If anything in this specification is ambiguous, **ask before implementing it.**

Do not guess.

---

# 84. PROJECT NORTH STAR

The long-term objective is not simply:

> "Build another ride-sharing app."

The objective is to build an automated transportation coordination system where thousands of independent trips can continuously be combined into efficient shared journeys.

The system should progressively transform:

```text
many individual vehicles
        ↓
many partially overlapping journeys
        ↓
continuous optimization
        ↓
shared routes
        ↓
higher vehicle occupancy
        ↓
fewer unnecessary trips
        ↓
lower transportation cost
        ↓
lower resource consumption
```

The product should therefore be designed from day one as an **optimization platform**, not merely as a taxi-booking application.

---

## END OF SPECIFICATION
