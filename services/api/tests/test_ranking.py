"""Order of connections: "Earliest arrival" prefers simpler journeys when arrivals are
close (fewer changes, less walking), but never by more than MAX_COMFORT_COST."""

from datetime import datetime, timedelta

from app.journeys import (
    MAX_COMFORT_COST,
    Journey,
    LegTime,
    SortOption,
    comfort_cost,
    sort_journeys,
)
from app.timetable import MADRID


def at(hh: int, mm: int, ss: int = 0) -> datetime:
    return datetime(2026, 11, 16, hh, mm, ss, tzinfo=MADRID)


def journey(
    jid: str,
    dep: datetime,
    arr: datetime,
    transfers: int = 0,
    walk: int = 0,
    feasible: bool = True,
    live_arr: datetime | None = None,
) -> Journey:
    return Journey(
        id=jid,
        departure=LegTime(scheduled=dep),
        arrival=LegTime(
            scheduled=arr, estimated=live_arr, status="live" if live_arr else "scheduled"
        ),
        duration_min=int((arr - dep).total_seconds() // 60),
        transfers=transfers,
        walk_min=walk,
        legs=[],
        changes=[],
        reliability=None,
        feasible=feasible,
        issues=[],
        data_quality="scheduled",
    )


def ids(js: list[Journey], sort: SortOption = "earliest_arrival") -> list[str]:
    return [j.id for j in sort_journeys(js, sort)]


def test_comfort_cost_counts_changes_and_walking_up_to_the_cap() -> None:
    assert comfort_cost(journey("a", at(14, 0), at(14, 30))) == timedelta(0)
    assert comfort_cost(journey("a", at(14, 0), at(14, 30), walk=4)) == timedelta(minutes=1)
    assert comfort_cost(journey("a", at(14, 0), at(14, 30), transfers=1)) == timedelta(minutes=3)
    assert comfort_cost(journey("a", at(14, 0), at(14, 30), transfers=3)) == MAX_COMFORT_COST


def test_direct_ride_goes_first_when_it_arrives_a_little_later() -> None:
    # Campus Sur case: 331 + E arrives 2 min before the direct E but walks more.
    change = journey("change", at(14, 2), at(14, 29), transfers=1, walk=8)
    direct = journey("direct", at(14, 0), at(14, 31), walk=4)
    assert ids([change, direct]) == ["direct", "change"]


def test_same_arrival_fewer_changes_first_then_less_walking() -> None:
    three = journey("three", at(20, 22), at(21, 16), transfers=3, walk=8)
    two = journey("two", at(20, 9), at(21, 16), transfers=2, walk=16)
    assert ids([three, two]) == ["two", "three"]
    long_walk = journey("long", at(19, 0), at(19, 30), walk=12)
    short_walk = journey("short", at(19, 5), at(19, 30), walk=3)
    assert ids([long_walk, short_walk]) == ["short", "long"]


def test_never_jumps_more_than_the_cap() -> None:
    # Direct but 7 min later: the faster journey with a change stays first.
    change = journey("change", at(8, 0), at(8, 26), transfers=1, walk=3)
    direct = journey("direct", at(8, 0), at(8, 33), walk=3)
    assert ids([direct, change]) == ["change", "direct"]
    # Even the worst journey (cost capped) is only pushed back by MAX_COMFORT_COST.
    messy = journey("messy", at(8, 0), at(8, 20), transfers=4, walk=40)
    simple = journey("simple", at(8, 0), at(8, 26))
    assert ids([simple, messy]) == ["messy", "simple"]


def test_trade_off_keeps_earliest_when_the_simpler_one_walks_much_more() -> None:
    # Parla -> Retiro: change + 3 min walk at 09:21 vs direct + 23 min walk at 09:24.
    change = journey("change", at(8, 34), at(9, 21), transfers=1, walk=3)
    direct = journey("direct", at(8, 34), at(9, 24), walk=23)
    assert ids([direct, change]) == ["change", "direct"]


def test_uses_live_arrival() -> None:
    late = journey("late", at(9, 0), at(9, 20), live_arr=at(9, 32))
    other = journey("other", at(9, 5), at(9, 28), transfers=1)
    assert ids([late, other]) == ["other", "late"]


def test_infeasible_journeys_stay_last() -> None:
    broken = journey("broken", at(9, 0), at(9, 10), feasible=False)
    ok = journey("ok", at(9, 0), at(9, 40), transfers=2, walk=30)
    assert ids([broken, ok]) == ["ok", "broken"]


def test_other_sort_options_are_unchanged() -> None:
    fast = journey("fast", at(9, 0), at(9, 20), transfers=2, walk=10)
    slow = journey("slow", at(9, 0), at(9, 22))
    assert ids([slow, fast], "fastest") == ["fast", "slow"]
    assert ids([fast, slow], "fewest_transfers") == ["slow", "fast"]
    assert ids([fast, slow], "least_walking") == ["slow", "fast"]
