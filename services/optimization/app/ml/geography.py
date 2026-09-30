"""Where synthetic trips happen (the ETA and cancellation prototypes' own training data).

Reuses this codebase's own already-established test city (tests/e2e/helpers.ts's own PLACES -
Canary Wharf, London, is the one real-world place used throughout this repo's own fixtures) rather
than inventing a new geography, plus a small set of named, plausible London hotspots around it -
real places, but their own relative popularity weight below is invented for this generator, not
measured.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Hotspot:
    name: str
    latitude: float
    longitude: float
    weight: float


# A ~15 km-wide box around Canary Wharf (51.5049, -0.0195) - wide enough to hold every hotspot below
# with room for jitter, without reaching into a genuinely different city.
BOUNDING_BOX = {
    "min_latitude": 51.42,
    "max_latitude": 51.58,
    "min_longitude": -0.25,
    "max_longitude": 0.15,
}

# name, latitude, longitude, relative weight (how often a trip starts/ends near here - invented,
# not measured), kind (only used for documentation; every hotspot shares the SAME hour-of-day
# curve below, a deliberate simplification - see synthetic_data.py's own header comment).
HOTSPOTS: list[Hotspot] = [
    Hotspot("Canary Wharf", 51.5049, -0.0195, 0.20),
    Hotspot("King's Cross", 51.5308, -0.1238, 0.18),
    Hotspot("Waterloo", 51.5033, -0.1145, 0.16),
    Hotspot("Shoreditch", 51.5229, -0.0777, 0.14),
    Hotspot("Camden", 51.5390, -0.1426, 0.12),
    Hotspot("Brixton", 51.4613, -0.1156, 0.12),
    Hotspot("Greenwich", 51.4826, -0.0077, 0.08),
]

# The share of trips whose own pickup/dropoff is NOT near a hotspot at all - a fully random point
# in the bounding box, representing the less predictable demand any real city also has away from
# its own obvious hubs.
RANDOM_LOCATION_SHARE = 0.15

# Roughly 1 km of jitter around a hotspot's own center (at this latitude, 1 degree of longitude is
# narrower than 1 degree of latitude - ignored here, a prototype-scale simplification).
HOTSPOT_JITTER_DEGREES = 0.01
