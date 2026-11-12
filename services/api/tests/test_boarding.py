"""Boarding a frequency bus at its stop nearest to you (app/boarding.py)."""

import asyncio
from datetime import date, datetime

from app.boarding import TripStop, board_nearer, decode, encode
from app.journeys import Leg, LegStop, LegTime, Place, _Draft, _Itinerary
from app.otp import Walk
from app.timetable import MADRID

# Biblioteca Campus Sur UPM -> line E (case reported 2026-11-12).
LIBRARY = Place(name="Biblioteca Campus Sur UPM", lat=40.390503, lon=-3.626981)
E_STOPS = [
    TripStop("4280", "Sierra de Guadalupe", 40.3846, -3.6262, 50_000),
    TripStop("4281", "Polideportivo Campus Sur", 40.38859, -3.62695, 50_120),
    TripStop("2613", "Mediterráneo - Democracia", 40.39171, -3.62415, 50_200),
    TripStop("2125", "Av. Mediterráneo - Conde De Casal", 40.40703, -3.67091, 51_100),
]


def t(hhmm: str) -> datetime:
    h, m = hhmm.split(":")
    return datetime(2026, 11, 13, int(h), int(m), tzinfo=MADRID)


def journey(status: str = "frequency", headway: int | None = 16) -> _Itinerary:
    walk = Leg(
        mode="walk",
        **{"from": LIBRARY.name},
        to="Mediterráneo - Democracia",
        to_stop_id="emt:2613",
        departure=LegTime(scheduled=t("14:00")),
        arrival=LegTime(scheduled=t("14:04")),
        duration_min=5,
        distance_m=361,
        from_lat=LIBRARY.lat,
        from_lon=LIBRARY.lon,
        to_lat=40.39171,
        to_lon=-3.62415,
        geometry=encode([(LIBRARY.lat, LIBRARY.lon), (40.39171, -3.62415)]),
    )
    bus = Leg(
        mode="bus",
        trip_id="emt:E1",
        **{"from": "Mediterráneo - Democracia"},
        to="Av. Mediterráneo - Conde De Casal",
        from_stop_id="emt:2613",
        to_stop_id="emt:2125",
        departure=LegTime(scheduled=t("14:20"), status=status),  # type: ignore[arg-type]
        arrival=LegTime(scheduled=t("14:36"), status=status),  # type: ignore[arg-type]
        duration_min=16,
        distance_m=6107,
        headway_min=headway,
        intermediate=[LegStop(name="Somewhere", stop_id="emt:1", time=t("14:28"))],
        geometry=encode([(40.39171, -3.62415), (40.40703, -3.67091)]),
    )
    return _Itinerary(
        drafts=[
            _Draft(leg=walk, duration_s=270),
            _Draft(
                leg=bus,
                feed="emt",
                trip_native="E1",
                from_native="2613",
                to_native="2125",
                service_day=date(2026, 11, 13),
                duration_s=960,
                otp_start=t("14:20"),
                otp_end=t("14:36"),
            ),
        ],
        feeds={"emt"},
    )


class Walks:
    def __init__(self, walk: Walk | None) -> None:
        self.result, self.asked = walk, []  # type: ignore[var-annotated]

    async def walk(self, origin: tuple[float, float], dest: tuple[float, float]) -> Walk | None:
        self.asked.append(dest)
        return self.result


def run(its: list[_Itinerary], walks: Walks, stops: list[TripStop] = E_STOPS) -> None:
    asyncio.run(board_nearer(its, {("emt", "E1"): stops}, walks))


def test_boards_the_same_bus_at_the_nearer_earlier_stop() -> None:
    it = journey()
    walks = Walks(Walk(distance_m=297, duration_s=266, geometry="abc"))
    run([it], walks)
    walk, bus = it.drafts[0].leg, it.drafts[1].leg
    assert walks.asked == [(40.38859, -3.62695)]  # only the nearest stop, once
    assert bus.from_ == "Polideportivo Campus Sur" and bus.from_stop_id == "emt:4281"
    assert bus.departure.scheduled == datetime(2026, 11, 13, 14, 18, 40, tzinfo=MADRID)  # 80 s
    assert bus.departure.status == "frequency"
    assert bus.arrival.scheduled == t("14:36")  # you get off at the same time
    assert [s.name for s in bus.intermediate] == ["Mediterráneo - Democracia", "Somewhere"]
    assert bus.distance_m is not None and bus.distance_m > 6107
    assert decode(bus.geometry or "")[0] == (40.38859, -3.62695)
    assert it.drafts[1].from_native == "4281"
    assert walk.to == "Polideportivo Campus Sur" and walk.to_stop_id == "emt:4281"
    assert walk.distance_m == 297 and walk.geometry == "abc"
    assert walk.departure.scheduled == t("14:00")
    assert walk.arrival.scheduled == datetime(2026, 11, 13, 14, 4, 26, tzinfo=MADRID)


def test_keeps_otps_stop_when_the_walk_is_not_shorter() -> None:
    it = journey()
    run([it], Walks(Walk(distance_m=350, duration_s=300, geometry=None)))
    assert it.drafts[1].leg.from_ == "Mediterráneo - Democracia"


def test_keeps_otps_stop_when_otp_has_no_walk() -> None:
    it = journey()
    run([it], Walks(None))
    assert it.drafts[1].leg.from_ == "Mediterráneo - Democracia"


def test_keeps_otps_stop_when_you_cannot_reach_the_bus_there() -> None:
    it = journey()
    run([it], Walks(Walk(distance_m=200, duration_s=20 * 60, geometry=None)))
    assert it.drafts[1].leg.from_ == "Mediterráneo - Democracia"


def test_timetabled_and_live_buses_are_left_alone() -> None:
    for it in (journey(status="scheduled", headway=None), journey(status="live")):
        walks = Walks(Walk(distance_m=100, duration_s=60, geometry=None))
        run([it], walks)
        assert walks.asked == []
        assert it.drafts[1].leg.from_ == "Mediterráneo - Democracia"


def test_no_earlier_stop_nearby() -> None:
    it = journey()
    far = [TripStop("9", "Far away", 40.42, -3.70, 49_000), *E_STOPS[2:]]
    walks = Walks(Walk(distance_m=100, duration_s=60, geometry=None))
    run([it], walks, far)
    assert walks.asked == []


def test_polyline_round_trip() -> None:
    pts = [(40.38859, -3.62695), (40.39171, -3.62415), (40.40703, -3.67091)]
    assert decode(encode(pts)) == pts
    assert encode([(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]) == (
        "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
    )


def after_a_train() -> _Itinerary:
    """A train to a station next to the library, then the same walk and line E."""
    it = journey()
    walk = it.drafts[0].leg
    walk.from_ = "Some station"
    walk.departure = LegTime(scheduled=t("14:00"))
    train = Leg(
        mode="rail",
        trip_id="cercanias:T1",
        **{"from": "Atocha"},
        to="Some station",
        departure=LegTime(scheduled=t("13:40")),
        arrival=LegTime(scheduled=t("14:00")),
        duration_min=20,
        to_lat=LIBRARY.lat,
        to_lon=LIBRARY.lon,
    )
    it.drafts.insert(0, _Draft(leg=train, feed="cercanias", trip_native="T1", duration_s=1200))
    return it


def test_a_change_onto_the_bus_also_boards_at_the_nearer_stop() -> None:
    it = after_a_train()
    walks = Walks(Walk(distance_m=297, duration_s=266, geometry="abc"))
    run([it], walks)
    walk, bus = it.drafts[1].leg, it.drafts[2].leg
    assert bus.from_ == "Polideportivo Campus Sur"
    assert walk.to == "Polideportivo Campus Sur" and walk.distance_m == 297
    assert walk.departure.scheduled == t("14:00")  # still when the train arrives
    assert it.drafts[0].leg.to == "Some station"  # the train is untouched


def test_a_change_keeps_otps_stop_when_the_bus_would_be_missed() -> None:
    it = after_a_train()
    run([it], Walks(Walk(distance_m=200, duration_s=19 * 60, geometry=None)))
    assert it.drafts[2].leg.from_ == "Mediterráneo - Democracia"
