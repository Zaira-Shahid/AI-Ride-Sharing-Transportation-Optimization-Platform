import pytest

from app.geo import Point, bearing_degrees, bearing_difference_degrees, distance_meters


def test_bearing_reads_due_east_as_90_and_due_south_as_180() -> None:
    assert bearing_degrees(Point(0, 0), Point(0, 1)) == pytest.approx(90, abs=0.5)
    assert bearing_degrees(Point(1, 0), Point(0, 0)) == pytest.approx(180, abs=0.5)


def test_bearing_difference_is_the_smaller_angle_either_way_round_the_compass() -> None:
    assert bearing_difference_degrees(10, 20) == 10
    assert bearing_difference_degrees(350, 10) == 20
    assert bearing_difference_degrees(0, 180) == 180


def test_distance_between_the_same_point_is_zero() -> None:
    point = Point(51.4545, -2.5879)
    assert distance_meters(point, point) == 0


def test_distance_matches_a_known_short_hop() -> None:
    # ~629 m, the same pair used on the TypeScript side (functions/src/matching.test.ts).
    origin = Point(58, -1)
    pickup = Point(58.005, -0.995)
    assert distance_meters(origin, pickup) == pytest.approx(629, abs=10)
