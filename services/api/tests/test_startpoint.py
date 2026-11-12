"""Planning from a point next to an address OTP would link to a dead end (app/startpoint.py)."""

import asyncio

import pytest

from app import startpoint
from app.journeys import Journey, Leg, LegTime, Place, from_address
from app.otp import Walk
from app.startpoint import around, unstick
from app.trips import distance_m

# Avenida Leguario 102, Parla, and the stop 100 m away (case reported 2026-11-12).
ADDRESS = (40.225201, -3.774869)
STOP = (40.2248714, -3.7737757)


@pytest.fixture(autouse=True)
def empty_cache() -> None:
    startpoint._cache.clear()


class Walks:
    """The address itself is stuck (905 m); any other point walks straight (x1.2)."""

    def __init__(self, stuck: bool = True) -> None:
        self.stuck, self.asked = stuck, 0

    async def walk(self, a: tuple[float, float], b: tuple[float, float]) -> Walk | None:
        self.asked += 1
        if self.stuck and ADDRESS in (a, b):
            return Walk(distance_m=905, duration_s=746, geometry=None)
        return Walk(distance_m=distance_m(a, b) * 1.2, duration_s=60, geometry=None)


def test_a_stuck_address_is_moved_a_few_metres() -> None:
    moved = asyncio.run(unstick(ADDRESS, STOP, Walks(), end=False))
    assert moved is not None and moved != ADDRESS
    assert distance_m(ADDRESS, moved) <= 31


def test_a_fine_address_is_kept_with_one_walk_asked() -> None:
    walks = Walks(stuck=False)
    assert asyncio.run(unstick(ADDRESS, STOP, walks, end=True)) is None
    assert walks.asked == 1


def test_no_stop_nearby_asks_nothing() -> None:
    walks = Walks()
    assert asyncio.run(unstick(ADDRESS, None, walks, end=False)) is None
    assert walks.asked == 0


def test_answers_are_remembered() -> None:
    walks = Walks()
    first = asyncio.run(unstick(ADDRESS, STOP, walks, end=False))
    asked = walks.asked
    assert asyncio.run(unstick(ADDRESS, STOP, walks, end=False)) == first
    assert walks.asked == asked


def test_points_around_are_at_the_given_distances() -> None:
    pts = around(ADDRESS)
    assert len(pts) == 24
    for p, metres in pts:
        assert distance_m(ADDRESS, p) == pytest.approx(metres, rel=0.02)


def test_the_walk_is_drawn_from_the_real_address() -> None:
    from app.boarding import decode, encode

    real = Place(name="Avenida Leguario 102", lat=ADDRESS[0], lon=ADDRESS[1])
    used = real.model_copy(update={"lat": 40.22535, "lon": -3.77487})
    t = LegTime.model_validate({"scheduled": "2026-11-13T14:00:00+01:00"})
    walk = Leg(
        mode="walk",
        **{"from": real.name},
        to="Av. Leguario - Parque de los Escritores",
        departure=t,
        arrival=t,
        duration_min=2,
        distance_m=100,
        from_lat=used.lat,
        from_lon=used.lon,
        geometry=encode([(used.lat, used.lon), STOP]),
    )
    j = Journey.model_validate(
        {
            "id": "x",
            "departure": t,
            "arrival": t,
            "duration_min": 2,
            "transfers": 0,
            "walk_min": 2,
            "legs": [walk],
            "changes": [],
            "reliability": None,
            "feasible": True,
            "issues": [],
            "data_quality": "scheduled",
        }
    )
    stop = Place(name="stop", lat=STOP[0], lon=STOP[1])
    from_address(j, real, used, stop, stop)
    leg = j.legs[0]
    assert (leg.from_lat, leg.from_lon) == ADDRESS
    assert decode(leg.geometry or "")[0] == (round(ADDRESS[0], 5), round(ADDRESS[1], 5))
    assert leg.distance_m == 100 + round(distance_m(ADDRESS, (used.lat, used.lon)))
