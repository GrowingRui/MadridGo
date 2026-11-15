"""drop_feeder_copies: a journey that only adds a short ride onto the same vehicle as a
simpler journey is dropped; a feeder that really helps (earlier, or much less walking)
stays."""

from datetime import datetime

from app.journeys import Journey, Leg, LegTime, drop_feeder_copies
from app.stops import Line
from app.timetable import MADRID


def at(hh: int, mm: int) -> datetime:
    return datetime(2026, 11, 16, hh, mm, tzinfo=MADRID)


def line(route: str) -> Line:
    return Line(
        source="emt",
        route_id=route,
        short_name=route,
        long_name=None,
        mode="bus",
        color=None,
        text_color=None,
    )


def ride(
    route: str,
    frm: str,
    to: str,
    dep: datetime,
    arr: datetime,
    headway: int | None = 10,
    trip: str | None = None,
    mode: str = "bus",
) -> Leg:
    return Leg(
        mode=mode,
        line=line(route),
        trip_id=trip,
        **{"from": frm},
        to=to,
        from_stop_id=frm,
        to_stop_id=to,
        departure=LegTime(scheduled=dep, status="frequency" if headway else "scheduled"),
        arrival=LegTime(scheduled=arr, status="frequency" if headway else "scheduled"),
        duration_min=int((arr - dep).total_seconds() // 60),
        headway_min=headway,
    )


def walk(dep: datetime, arr: datetime) -> Leg:
    return Leg(
        mode="walk",
        **{"from": "a"},
        to="b",
        departure=LegTime(scheduled=dep),
        arrival=LegTime(scheduled=arr),
        duration_min=int((arr - dep).total_seconds() // 60),
    )


def journey(jid: str, legs: list[Leg], walk_min: int, feasible: bool = True) -> Journey:
    rides = [lg for lg in legs if lg.mode != "walk"]
    return Journey(
        id=jid,
        departure=legs[0].departure,
        arrival=legs[-1].arrival,
        duration_min=int((legs[-1].arrival.best - legs[0].departure.best).total_seconds() // 60),
        transfers=max(0, len(rides) - 1),
        walk_min=walk_min,
        legs=legs,
        changes=[],
        reliability=None,
        feasible=feasible,
        issues=[],
        data_quality="scheduled",
    )


def ids(js: list[Journey]) -> list[str]:
    return [j.id for j in drop_feeder_copies(js)]


# Campus Sur -> Conde Casal, 2026-11-16 14:00 (seen live 2026-11-15).
DIRECT = journey(
    "E",
    [walk(at(14, 8), at(14, 14)), ride("E", "campus_sur", "conde_casal", at(14, 14), at(14, 32))],
    walk_min=6,
)
VIA_331 = journey(
    "331+E",
    [
        walk(at(14, 0), at(14, 10)),
        ride("331", "democracia", "fontarron", at(14, 10), at(14, 13)),
        ride("E", "fontarron", "conde_casal", at(14, 26), at(14, 31)),
    ],
    walk_min=12,
)


def test_short_ride_onto_the_same_bus_is_dropped() -> None:
    assert ids([DIRECT, VIA_331]) == ["E"]
    assert ids([VIA_331, DIRECT]) == ["E"]  # whatever the order


def test_feeder_onto_a_different_bus_line_stays() -> None:
    via_143 = journey(
        "331+143",
        [
            walk(at(14, 0), at(14, 10)),
            ride("331", "democracia", "fontarron", at(14, 10), at(14, 13)),
            ride("143", "fontarron", "conde_casal", at(14, 23), at(14, 33)),
        ],
        walk_min=11,
    )
    assert ids([DIRECT, via_143]) == ["E", "331+143"]


def test_feeder_onto_the_next_bus_of_the_line_stays() -> None:
    # Same line, but a bus a full headway later: not the same vehicle.
    later = journey(
        "331+E later",
        [
            walk(at(14, 0), at(14, 10)),
            ride("331", "democracia", "fontarron", at(14, 10), at(14, 13)),
            ride("E", "fontarron", "conde_casal", at(14, 36), at(14, 42)),
        ],
        walk_min=4,
    )
    assert ids([DIRECT, later]) == ["E", "331+E later"]


def test_feeder_that_saves_a_long_walk_stays() -> None:
    # Moncloa -> Atocha: bus C2 to Príncipe Pío instead of a 33 min walk, same C10 train.
    train = ride("C10", "principe_pio", "atocha", at(11, 8), at(11, 20), headway=None, trip="t1")
    walk_only = journey("C10", [walk(at(10, 35), at(11, 8)), train], walk_min=33)
    bus_first = journey(
        "C2+C10",
        [
            walk(at(10, 35), at(10, 42)),
            ride("C2", "isaac_peral", "principe_pio", at(10, 42), at(10, 54)),
            train,
        ],
        walk_min=7,
    )
    assert ids([bus_first, walk_only]) == ["C2+C10", "C10"]


def test_feeder_that_arrives_clearly_earlier_stays() -> None:
    # Vallecas -> Plaza Castilla: bus 171 after the train instead of walking, 6 min earlier.
    train = ride("C2", "vallecas", "chamartin", at(10, 47), at(11, 13), headway=None, trip="t2")
    walk_end = journey("C2", [train, walk(at(11, 13), at(11, 27))], walk_min=12)
    bus_after = journey(
        "C2+171",
        [
            train,
            ride("171", "chamartin", "plaza_castilla", at(11, 18), at(11, 21)),
        ],
        walk_min=10,
    )
    assert ids([bus_after, walk_end]) == ["C2+171", "C2"]


def test_different_train_is_not_the_same_vehicle() -> None:
    direct = journey(
        "C5",
        [ride("C5", "leganes", "embajadores", at(10, 53), at(11, 15), headway=None, trip="a")],
        walk_min=10,
    )
    feeder = journey(
        "483+C5",
        [
            ride("483", "museo", "aluche", at(10, 55), at(10, 57)),
            ride("C5", "aluche", "embajadores", at(11, 10), at(11, 18), headway=None, trip="b"),
        ],
        walk_min=10,
    )
    assert ids([direct, feeder]) == ["C5", "483+C5"]


def test_not_dropped_for_an_infeasible_journey() -> None:
    broken = DIRECT.model_copy(update={"feasible": False})
    assert ids([broken, VIA_331]) == ["E", "331+E"]
