"""Live train position (`GET /trips/{trip_id}/position`, Phase 5).

The recorded tests replay Renfe's real feeds of 2026-11-09 17:55 UTC
(tests/fixtures/realtime/) with the timetable of three of those trains
(renfe_trip_stops.json), so they check what Renfe's fields really mean. No docker needed.
"""

import json
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.realtime.models import FeedSnapshot, TripRealtime, VehicleRealtime
from app.realtime.renfe import parse_trip_updates, parse_vehicle_positions
from app.realtime.service import get_realtime
from app.timetable import at_service_time
from app.trips import TripStop, estimate, get_trip_timetable, locate, project
from tests.realtime_helpers import FIXTURES, realtime_with

FEED_TIME = datetime(2026, 11, 9, 17, 55, 5, tzinfo=UTC)
NOW = FEED_TIME + timedelta(seconds=20)

C7_MOVING = "1012L75852C7"  # IN_TRANSIT_TO; GPS halfway between Chamartín and N. Ministerios
C4A_STOPPED = "1012L27281C4a"  # STOPPED_AT, 13th stop
C8B_STANDING = "1012L27629C8b"  # labelled INCOMING_AT, but standing at Villalba (16 m)


def _stops(raw: list[dict[str, Any]]) -> list[TripStop]:
    return [
        TripStop(
            index=i,
            native_id=s["native_id"],
            stop_id=f"renfe:{s['native_id']}",
            root_id=f"renfe:{s['native_id']}",
            name=s["name"],
            lat=s["lat"],
            lon=s["lon"],
            arrival_s=s["arrival_s"],
            departure_s=s["departure_s"],
        )
        for i, s in enumerate(raw)
    ]


TIMETABLE = {
    trip: _stops(stops)
    for trip, stops in json.loads(
        (FIXTURES / "renfe_trip_stops.json").read_text(encoding="utf-8")
    ).items()
    if trip != "_meta"
}


def recorded(retrieved: datetime = FEED_TIME) -> FeedSnapshot:
    snap = parse_trip_updates((FIXTURES / "renfe_trip_updates.pb").read_bytes(), retrieved)
    _, snap.vehicles = parse_vehicle_positions(
        (FIXTURES / "renfe_vehicle_positions.pb").read_bytes()
    )
    return snap


# ---------------------------------------------------------------------------
# Recorded Renfe data


def test_moving_train_is_placed_between_stations_from_its_gps() -> None:
    p = locate(f"cercanias:{C7_MOVING}", TIMETABLE[C7_MOVING], recorded(), NOW)
    assert p.status == "between"
    assert p.last_stop is not None and p.next_stop is not None
    # Renfe's vehicle stop_id is the station just left; the trip update names the next one.
    assert (p.last_stop.index, p.next_stop.index) == (9, 10)
    assert "Chamart" in p.last_stop.name and "Nuevos Ministerios" in p.next_stop.name
    assert p.progress_basis == "gps"
    assert p.progress is not None and 0.4 < p.progress < 0.6
    assert p.expected_at_next is not None  # Renfe's prediction for the next stop
    assert p.segment_run_s is not None and p.segment_run_s > 0
    assert p.freshness is not None and p.freshness.state == "FRESH"
    assert p.observed_at == FEED_TIME
    assert p.attribution == "Renfe (CC BY 4.0)"


def test_stopped_train_is_at_its_station() -> None:
    p = locate(f"cercanias:{C4A_STOPPED}", TIMETABLE[C4A_STOPPED], recorded(), NOW)
    assert p.status == "at_stop"
    assert p.last_stop is not None and p.last_stop.index == 13
    assert p.next_stop is not None and p.next_stop.index == 14
    assert p.progress == 0.0
    assert p.delay_s == 780


def test_gps_wins_over_status_label() -> None:
    """INCOMING_AT, but the GPS fix is 16 m from the station: the train stands there."""
    snap = recorded()
    assert snap.vehicles[C8B_STANDING].current_status == "INCOMING_AT"
    p = locate(f"cercanias:{C8B_STANDING}", TIMETABLE[C8B_STANDING], snap, NOW)
    assert p.status == "at_stop"
    assert p.last_stop is not None and p.last_stop.index == 8


def test_stops_away_from_the_boarding_stop() -> None:
    stops = TIMETABLE[C4A_STOPPED]
    snap = recorded()
    later = stops[14].stop_id
    p = locate(f"cercanias:{C4A_STOPPED}", stops, snap, NOW, from_stop=later)
    assert (p.board_index, p.stops_away) == (14, 1)
    here = locate(f"cercanias:{C4A_STOPPED}", stops, snap, NOW, from_stop=stops[13].stop_id)
    assert here.stops_away == 0
    passed = locate(f"cercanias:{C4A_STOPPED}", stops, snap, NOW, from_stop=stops[2].stop_id)
    assert passed.stops_away is not None and passed.stops_away < 0
    elsewhere = locate(f"cercanias:{C4A_STOPPED}", stops, snap, NOW, from_stop="renfe:nope")
    assert (elsewhere.board_index, elsewhere.stops_away) == (None, None)


# ---------------------------------------------------------------------------
# Freshness and missing data: no point rather than a wrong one


def test_stale_data_falls_back_to_a_timetable_estimate() -> None:
    """Never an old live position: STALE data gives the timetable estimate, labelled."""
    old = NOW + timedelta(minutes=4)  # over the 3 min STALE threshold
    p = locate(f"cercanias:{C7_MOVING}", TIMETABLE[C7_MOVING], recorded(), old)
    assert p.kind == "estimated" and p.progress_basis == "timetable"
    assert p.delay_s is None  # the outdated delay is not used either
    assert p.freshness is not None and p.freshness.state == "STALE"


def test_delayed_update_still_gives_a_position() -> None:
    later = FEED_TIME + timedelta(seconds=120)  # DELAYED_UPDATE: shown, with its age
    p = locate(f"cercanias:{C7_MOVING}", TIMETABLE[C7_MOVING], recorded(), later)
    assert p.status == "between"
    assert p.freshness is not None and p.freshness.state == "DELAYED_UPDATE"
    assert p.freshness.age_s == 120


def test_no_snapshot_gives_a_timetable_estimate() -> None:
    p = locate(f"cercanias:{C7_MOVING}", TIMETABLE[C7_MOVING], None, NOW)
    assert p.kind == "estimated" and p.status in ("at_stop", "between")
    assert p.observed_at == NOW and p.poll_after_s == 15


def test_train_without_vehicle_is_estimated_with_its_live_delay() -> None:
    snap = recorded()
    del snap.vehicles[C7_MOVING]
    p = locate(f"cercanias:{C7_MOVING}", TIMETABLE[C7_MOVING], snap, NOW)
    assert p.kind == "estimated"
    assert p.delay_s == snap.trips[C7_MOVING].delay_s
    assert "live delay" in p.message


def test_live_position_is_marked_live() -> None:
    p = locate(f"cercanias:{C7_MOVING}", TIMETABLE[C7_MOVING], recorded(), NOW)
    assert p.kind == "live"


def test_cancelled_train() -> None:
    snap = recorded()
    snap.trips[C7_MOVING] = snap.trips[C7_MOVING].model_copy(update={"cancelled": True})
    p = locate(f"cercanias:{C7_MOVING}", TIMETABLE[C7_MOVING], snap, NOW)
    assert (p.status, p.reason) == ("unavailable", "cancelled")


# ---------------------------------------------------------------------------
# Synthetic cases

LINE = _stops(
    [
        {
            "native_id": "A",
            "name": "A",
            "lat": 40.0,
            "lon": -3.7,
            "arrival_s": 0,
            "departure_s": 60,
        },
        {
            "native_id": "B",
            "name": "B",
            "lat": 40.01,
            "lon": -3.7,
            "arrival_s": 240,
            "departure_s": 270,
        },
        {
            "native_id": "C",
            "name": "C",
            "lat": 40.02,
            "lon": -3.7,
            "arrival_s": 450,
            "departure_s": 450,
        },
    ]
)


def snap_with(vehicle: dict[str, Any], tu: dict[str, Any] | None = None) -> FeedSnapshot:
    base = {
        "trip_id": "T",
        "vehicle_id": "1",
        "label": None,
        "platform": None,
        "lat": None,
        "lon": None,
        "current_status": "IN_TRANSIT_TO",
        "stop_id": "A",
        "timestamp": FEED_TIME,
    }
    trips = {}
    if tu is not None:
        trips["T"] = TripRealtime(
            trip_id="T",
            entity_id="x",
            cancelled=False,
            delay_s=tu.get("delay_s"),
            stop_id=tu.get("stop_id"),
            stop_time=tu.get("stop_time"),
        )
    return FeedSnapshot(
        source="renfe_gtfsrt",
        source_timestamp=FEED_TIME,
        retrieved_at=FEED_TIME,
        trips=trips,
        vehicles={"T": VehicleRealtime(**(base | vehicle))},
    )


def test_without_gps_progress_comes_from_the_predicted_arrival() -> None:
    # B is 180 s from A; Renfe predicts B in 45 s: three quarters of the way.
    snap = snap_with({}, {"stop_id": "B", "stop_time": NOW + timedelta(seconds=45)})
    p = locate("cercanias:T", LINE, snap, NOW)
    assert p.status == "between" and p.progress_basis == "timetable"
    assert p.progress == pytest.approx(0.75)
    assert p.segment_run_s == 180


def test_without_gps_or_prediction_progress_is_unknown() -> None:
    p = locate("cercanias:T", LINE, snap_with({}), NOW)
    assert p.status == "between"
    assert p.progress is None and p.progress_basis is None


def test_without_gps_a_stopped_label_is_trusted() -> None:
    p = locate("cercanias:T", LINE, snap_with({"current_status": "STOPPED_AT"}), NOW)
    assert p.status == "at_stop"


def test_progress_never_sits_on_a_station() -> None:
    # GPS ~220 m short of A (e.g. a train waiting before the platform), so not at A: drawn
    # 5 % along, not on top of A.
    p = locate("cercanias:T", LINE, snap_with({"lat": 39.998, "lon": -3.7}), NOW)
    assert p.status == "between" and p.progress == 0.05


def test_gps_far_off_the_line_falls_back_to_the_timetable() -> None:
    snap = snap_with(
        {"lat": 40.005, "lon": -3.6},  # ~8.5 km east of the line
        {"stop_id": "B", "stop_time": NOW + timedelta(seconds=90)},
    )
    p = locate("cercanias:T", LINE, snap, NOW)
    assert p.progress_basis == "timetable" and p.progress == pytest.approx(0.5)


def test_at_the_terminus() -> None:
    p = locate("cercanias:T", LINE, snap_with({"stop_id": "C", "lat": 40.03, "lon": -3.7}), NOW)
    assert p.status == "at_stop" and p.next_stop is None
    assert p.last_stop is not None and p.last_stop.name == "C"


def test_project() -> None:
    t, off = project((40.005, -3.7), (40.0, -3.7), (40.01, -3.7))
    assert t == pytest.approx(0.5) and off == pytest.approx(0, abs=1)


# ---------------------------------------------------------------------------
# Endpoint


class FakeTimetable:
    async def stops(self, feed: str, native_trip: str) -> list[TripStop]:
        return TIMETABLE.get(native_trip, [])


@pytest.fixture
def client() -> Iterator[TestClient]:
    app.dependency_overrides[get_trip_timetable] = FakeTimetable
    # The endpoint reads the clock itself: give the snapshot a current timestamp.
    now = datetime.now(UTC)
    snap = recorded(now)
    snap.source_timestamp = now
    app.dependency_overrides[get_realtime] = lambda: realtime_with(snap)
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_endpoint_returns_the_position(client: TestClient) -> None:
    stops = TIMETABLE[C7_MOVING]
    r = client.get(
        f"/trips/cercanias:{C7_MOVING}/position", params={"from_stop": stops[12].stop_id}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "between"
    assert body["last_stop"]["index"] == 9 and body["stops_away"] == 3
    assert body["poll_after_s"] == 30


def test_endpoint_metro_has_no_positions(client: TestClient) -> None:
    r = client.get("/trips/metro:4_I1_1/position")
    assert r.status_code == 200
    assert r.json()["reason"] == "not_supported"
    assert "Metro de Madrid" in r.json()["message"]


def test_endpoint_unknown_and_malformed_trips(client: TestClient) -> None:
    assert client.get("/trips/cercanias:nope/position").status_code == 404
    assert client.get("/trips/nocolon/position").status_code == 422


def test_snapped_to_the_station_but_due_to_have_left_is_between() -> None:
    """Renfe keeps a departed train at the station's coordinates (IN_TRANSIT_TO): the
    predicted arrival at B says it left A 60 s ago, so it is shown on the way."""
    snap = snap_with(
        {"lat": 40.0, "lon": -3.7, "current_status": "IN_TRANSIT_TO"},
        {"stop_id": "B", "stop_time": NOW + timedelta(seconds=120)},
    )
    p = locate("cercanias:T", LINE, snap, NOW)
    assert p.status == "between" and p.progress_basis == "timetable"
    assert p.progress == pytest.approx(1 / 3, abs=0.001)


def test_snapped_to_the_station_and_not_yet_due_is_at_the_station() -> None:
    snap = snap_with(
        {"lat": 40.0, "lon": -3.7, "current_status": "IN_TRANSIT_TO"},
        {"stop_id": "B", "stop_time": NOW + timedelta(seconds=240)},
    )
    assert locate("cercanias:T", LINE, snap, NOW).status == "at_stop"


def test_stopped_label_at_the_station_wins_even_when_late() -> None:
    snap = snap_with(
        {"lat": 40.0, "lon": -3.7, "current_status": "STOPPED_AT"},
        {"stop_id": "B", "stop_time": NOW + timedelta(seconds=30)},
    )
    assert locate("cercanias:T", LINE, snap, NOW).status == "at_stop"


# ---------------------------------------------------------------------------
# Timetable estimate (LINE: A dep 00:01, B arr 00:04 dep 00:04:30, C arr 00:07:30)

DAY = date(2026, 11, 9)


def t(seconds: int, day: date = DAY) -> datetime:
    return at_service_time(day, seconds)


def test_estimate_between_stations_moves_with_the_clock() -> None:
    p = locate("cercanias:T", LINE, None, t(150))
    assert (p.kind, p.status) == ("estimated", "between")
    assert p.last_stop is not None and p.last_stop.name == "A"
    assert p.progress == pytest.approx(0.5)
    assert p.left_at == t(60) and p.expected_at_next == t(240)
    assert p.segment_run_s == 180


def test_estimate_at_a_station_says_when_it_leaves() -> None:
    p = locate("cercanias:T", LINE, None, t(250))
    assert (p.kind, p.status) == ("estimated", "at_stop")
    assert p.last_stop is not None and p.last_stop.name == "B"
    assert p.departs_at == t(270) and p.expected_at_next == t(450)


def test_estimate_is_shifted_by_the_delay() -> None:
    e = estimate(LINE, t(270), delay_s=120)  # leaves A at 00:03, reaches B at 00:06
    assert e is not None and e.state == "between" and e.last.name == "A"
    assert e.left_at == t(180) and e.arrives_next == t(360)


def test_estimate_before_the_start_and_after_the_end() -> None:
    early = locate("cercanias:T", LINE, None, t(30))
    assert (early.status, early.reason) == ("unavailable", "not_started")
    assert "starts at A" in early.message
    late = locate("cercanias:T", LINE, None, t(500))
    assert (late.status, late.reason) == ("unavailable", "not_running")


def test_estimate_after_midnight_uses_yesterdays_service_day() -> None:
    night = _stops(
        [
            {
                "native_id": "A",
                "name": "A",
                "lat": 40.0,
                "lon": -3.7,
                "arrival_s": 86_400,
                "departure_s": 86_460,
            },
            {
                "native_id": "B",
                "name": "B",
                "lat": 40.01,
                "lon": -3.7,
                "arrival_s": 86_640,
                "departure_s": 86_640,
            },
        ]
    )
    e = estimate(night, t(150, date(2026, 11, 10)))  # 00:02:30 on the 10th
    assert e is not None and e.state == "between"
    assert e.left_at == t(86_460)
