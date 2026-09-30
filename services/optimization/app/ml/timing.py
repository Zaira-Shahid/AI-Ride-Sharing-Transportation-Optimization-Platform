"""When synthetic trips happen (the ETA and cancellation prototypes' own training data).

Two 24-hour demand curves - weekday and weekend - are used to WEIGHT which hour a synthetic trip's
own requested time falls in (not a uniform 1/24 each). Both are invented for this generator: a
plausible commute-shaped curve (low overnight, a morning rush, a bigger evening rush, quiet late)
for weekdays, and a flatter, later-starting one for weekends. Neither is derived from any real
demand data - there is none yet (see this package's own __init__.py). Every hotspot shares the
SAME curve (a deliberate simplification: a real city's own hotspots would each have their own
shape - an airport peaks differently from a nightlife district - but this generator does not
model that).
"""

from __future__ import annotations

# Index 0 = midnight-1am, ... index 23 = 11pm-midnight. Relative weights, not probabilities -
# normalized to sum to 1 wherever they are actually sampled from (synthetic_data.py).
WEEKDAY_HOURLY_WEIGHTS: list[float] = [
    1,
    1,
    1,
    1,
    2,
    4,  # 00-05: overnight, almost nothing
    8,
    14,
    16,
    10,
    6,
    6,  # 06-11: morning rush (07-08 peak), tapering
    7,
    6,
    6,
    7,
    9,
    14,  # 12-17: a lunchtime bump, building to the evening rush
    18,
    13,
    9,
    6,
    4,
    2,  # 18-23: evening rush (18 peak), tapering to late
]

WEEKEND_HOURLY_WEIGHTS: list[float] = [
    2,
    1,
    1,
    1,
    1,
    2,  # 00-05: quieter than a weekday night out would suggest - a simplification
    3,
    4,
    6,
    9,
    11,
    12,  # 06-11: a later, gentler rise - no commute rush
    13,
    13,
    12,
    11,
    11,
    12,  # 12-17: the day's own plateau
    13,
    12,
    10,
    8,
    6,
    4,  # 18-23: an evening peak, gentler than a weekday's
]


def is_weekend(day_of_week: int) -> bool:
    """`day_of_week` is Python's own convention: Monday=0 .. Sunday=6."""
    return day_of_week >= 5


def hourly_weights_for(day_of_week: int) -> list[float]:
    return WEEKEND_HOURLY_WEIGHTS if is_weekend(day_of_week) else WEEKDAY_HOURLY_WEIGHTS
