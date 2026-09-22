"""Plain geometry: distance and bearing between two points, in the same terms as candidate
discovery on the TypeScript side (functions/src/matching.ts) - not imported from there (a separate
language, a separate service), but deliberately the same formulas so the two agree.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import asin, atan2, cos, degrees, radians, sin, sqrt

EARTH_RADIUS_METERS = 6_371_008.8


@dataclass(frozen=True)
class Point:
    latitude: float
    longitude: float


def distance_meters(a: Point, b: Point) -> float:
    """The distance between two points along the earth's surface, in metres (haversine)."""
    d_lat = radians(b.latitude - a.latitude)
    d_lon = radians(b.longitude - a.longitude)
    h = (
        sin(d_lat / 2) ** 2
        + cos(radians(a.latitude)) * cos(radians(b.latitude)) * sin(d_lon / 2) ** 2
    )
    return 2 * EARTH_RADIUS_METERS * asin(min(1, sqrt(h)))


def bearing_degrees(a: Point, b: Point) -> float:
    """The initial compass bearing from `a` to `b`, clockwise from north (0 up to 360 degrees)."""
    lat1 = radians(a.latitude)
    lat2 = radians(b.latitude)
    d_lon = radians(b.longitude - a.longitude)
    y = sin(d_lon) * cos(lat2)
    x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(d_lon)
    return (degrees(atan2(y, x)) + 360) % 360


def bearing_difference_degrees(a: float, b: float) -> float:
    """The smaller angle between two compass bearings: 0 (same direction) up to 180 (opposite)."""
    diff = abs(a - b) % 360
    return 360 - diff if diff > 180 else diff
