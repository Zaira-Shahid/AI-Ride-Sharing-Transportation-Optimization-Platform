# A3b design note: a driver may decline a company match

Status: draft for review. Nothing in this note is built. It follows `docs/a3-company-matching-design.md` (section 1 named A3b) and the
Q3 decision in `docs/product-a-corporate-requirements.md`. A3a is merged: company rides are matched only inside their company, are
free, and employees use the same ride and driving functions as everyone else.

## 1. One question needs your answer before anything else

Two of our own sentences disagree about **what silence means**.

- Your Q3 answer: _"Auto-match the engine, with the driver able to decline within a time limit (**not manual approval of every rider**)."_
- The requirements doc, as I wrote it and you approved: _"A decline **or timeout** returns the rider to searching."_

If silence returns the rider to searching, then every match needs the driver to tap Accept, which is manual approval of every rider.
If silence leaves the match standing, the engine really does auto-match, and the driver only acts to say no. I read your answer as the
second, and the rest of this note is written that way. **I recommend "silence confirms"**, because a driver who is driving, or whose
phone is in a bag, would otherwise strand a rider every time. If you want the other behaviour, section 8 says what changes.

## 2. What A3b delivers

When the engine matches a company rider to a company driver, the driver gets a window (default 5 minutes, set by the company) to
decline. A decline sends the rider back to searching and never offers them to that driver again. Do nothing, or start heading to the
pickup, and the match is locked in.

| Part                              | What it does                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `declineMatchedRider({ tripId })` | The matched driver declines one rider inside the window                                                     |
| `confirmMatchedRider({ tripId })` | Optional: the driver accepts early, which ends the window so the rider can rely on it                       |
| A decision marker on the ride     | Written only on company rides by the three places that commit a match: `driverDecision` with its `deadline` |
| A "declined" list on the ride     | `declinedJourneyIds`: journeys this rider must not be matched to again                                      |
| A company setting                 | `driverDeclineWindowMinutes`: 0 to 30, default 5; 0 means matches are final at once                         |

## 3. No new ride state

The obvious design is a new status such as `PROPOSED`. I recommend against it. The existing machine already has what is needed:

- `PICKUP_ASSIGNED → SEARCHING` is already an allowed transition (`TRIP_STATUS_TRANSITIONS`), used when a driver goes offline.
- About twenty places read `PICKUP_ASSIGNED` (release rules, route reordering, the driver and passenger screens, payments, data rights,
  the status text). A new status would have to be taught to every one of them, and the consumer apps would see it.

So a company match stays `PICKUP_ASSIGNED`, with two extra fields that only company rides ever have. **Consumers never see a new state,
a new field or a new code path.** The window is derived, not stored as a state: the match is _open to decline_ while the ride is still
`PICKUP_ASSIGNED`, the driver has not confirmed, and `now < driverDecision.deadline`. Because silence confirms, **no timer or scheduled
sweep is needed**: the window simply closes by the clock, and a late decline is refused.

## 4. How a decline works

Declining one rider must leave any other riders on that journey intact, which is different from the driver going offline (that
releases everyone and sets the journey back to a draft). The pieces already exist in two places and A3b reuses both patterns:

1. **Release the one rider**, as `releaseDroppedRequest` in `routeModification.ts` does: status back to `SEARCHING`, the driver and
   vehicle fields cleared, a `RELEASED_TO_SEARCHING` notice and push to the rider, an audit entry. A new audit action,
   `TRIP_DECLINED_BY_DRIVER`, names who declined.
2. **Revise the plan**, as the delay re-ordering does: a new plan version with that rider's two stops removed, `supersedes` pointing at
   the old one, and the journey's `matchedTripRequestIds` updated. The new legs are worked out with the existing routing calls before the
   transaction, as insertion does. Removing a pair of stops cannot lengthen the route.
3. **If no rider is left**, the journey goes back to `AVAILABLE` (still online) so the driver can be matched again. The old plan is kept
   as history and the next match writes a fresh one; insertion already picks the newest plan.
4. **Never the same pairing again.** The journey id is added to the rider's `declinedJourneyIds`. The batch run drops those pairs before it
   checks any route, insertion skips those plans, and single assignment skips them. For a consumer the field never exists, so
   the filter removes nothing.

Everything runs in one transaction that re-checks the ride is still `PICKUP_ASSIGNED`, still matched to this driver, and still inside the
window. A repeated decline answers "unchanged".

## 5. Where the marker is written, and what stays the same

`driverDecision` is written by the same three commit points A3a already guards (batch apply, insertion apply, single assignment), and
**only when the ride's company is not null**. The deadline uses the company's setting, read once per company group before the run, so
a consumer's run reads nothing extra. For a consumer ride the code takes exactly the path it takes today.

Starting the pickup (`headToPickup`) before the deadline counts as accepting. That is one added check in the existing trip-step code,
skipped for any ride with no `driverDecision`.

## 6. What the people see

- **Driver**: the existing "New passenger" push, with the company's window added to its text, and in the employee app (A5) Accept and
  Decline buttons with a countdown. Both are optional, because silence confirms.
- **Rider**: the existing "Trip matched" push as now. If the driver declines, the existing "Finding a new driver" notice. There is a
  trade-off here, see question 4.
- **Company admin**: declines are audited. The dashboard (A7) shows counts only, for example how many matches each driver declined,
  never the rides or places.

## 7. Proof that consumers are unaffected, and that the feature works

A3a's characterization and mixed-world tests stay as they are and must still pass **unchanged**. In particular the golden files must be
byte-identical, which proves consumer documents gain no new key. New tests:

- A decline inside the window: the rider is released and told, the plan is revised, the declined journey is excluded, and the next batch
  run matches the rider to a **different** company driver.
- A sole rider declining returns the journey to `AVAILABLE`; one of two riders declining leaves the other intact on plan version 2.
- A decline after the window, from a driver who is not the matched one, on a confirmed ride, on a ride already past pickup, on a consumer
  ride, and by another company's driver is each refused with nothing written. A repeat answers "unchanged".
- Silence: no action leaves the match standing after the deadline. `headToPickup` before the deadline confirms. A 0-minute company window
  makes the match final immediately.
- A consumer ride never carries `driverDecision` or `declinedJourneyIds` (the shape test), and a consumer cannot call either new function.
- Mutation checks on each guard, then the full regression gate against `docs/baseline-a0.md`.

## 8. If you choose "silence releases the rider" instead

It is a smaller design in one way and a larger one in another. A window that must be answered needs something to act when it expires, so a
scheduled sweep (every minute or two, like the existing sweeps) would release unanswered matches and notify the rider. The emulator does
not run schedules, so tests would call the sweep directly. Riders would wait up to the window before their match is trustworthy, and a driver who
does not look at the app causes every one of their matches to bounce. I do not recommend it.

## 9. Not in A3b

The employee app's Accept and Decline screens (A5), the company setting screen (A4), the dashboard counts (A7), and any limit on how
many times one rider can be declined (none in v1; each decline is audited and counted, so a pattern is visible).

## 10. Questions for review

1. **What does silence mean?** Confirm the match (my recommendation, section 1) or release the rider?
2. **No new ride state**, using the existing `PICKUP_ASSIGNED → SEARCHING` and the two new fields (section 3). Agreed?
3. **Window length**: default 5 minutes, company-configurable from 0 to 30, where 0 makes matches final immediately. Agreed?
4. **When is the rider told they are matched?** Immediately, as today, and told if a driver declines (my recommendation), or held until the
   window closes, which avoids "matched, then unmatched" but delays every company rider's confirmation by up to the window and
   needs a timer after all?
5. **A declining driver is never offered the same rider again**, with no limit on declines in v1. Agreed?
6. **An explicit `confirmMatchedRider`** is included so a driver can end the window early. Agreed, or leave it out?
