"""Every Cercanías train on the map (`GET /trains/live`, `GET /trains/lines`, Phase 6).

Uses the recorded Renfe feeds of 2026-11-09 and the timetable of three of their trains, as
tests/test_trips.py does. No docker needed.
"""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.otp import OtpUnavailable, get_otp
from app.realtime.models import TripRealtime
from app.realtime.service import get_realtime
from app.stops import Line
from app.trains import (
    Network,
    NetworkCache,
    TrainInfo,
    build_network,
    decode_polyline,
    get_network_cache,
    get_train_timetable,
    line_order,
    live_trains,
    segment_path,
)
from tests.realtime_helpers import realtime_with
from tests.test_trips import C4A_STOPPED, C7_MOVING, C8B_STANDING, NOW, TIMETABLE, recorded

C7 = Line(
    source="cercanias",
    route_id="cercanias:10T0052C7",
    short_name="C7",
    long_name=None,
    mode="rail",
    color="E5202A",
    text_color="FFFFFF",
)
INFO = {trip: TrainInfo(line=C7, headsign="Alcalá de Henares") for trip in TIMETABLE}


def encode(points: list[tuple[float, float]]) -> str:
    """Google polyline encoding (precision 5), as OTP sends."""
    out, plat, plon = [], 0, 0
    for lat, lon in points:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def track_through(trip: str) -> list[tuple[float, float]]:
    """A track through the trip's stations, with a bend between each two of them."""
    pts: list[tuple[float, float]] = []
    stops = TIMETABLE[trip]
    for a, b in zip(stops, stops[1:], strict=False):
        assert a.lat and a.lon and b.lat and b.lon
        pts += [(a.lat, a.lon), ((a.lat + b.lat) / 2 + 0.001, (a.lon + b.lon) / 2)]
    pts.append((stops[-1].lat or 0, stops[-1].lon or 0))
    return pts


def network_for(*trips: str) -> Network:
    return Network(trip_track={t: track_through(t) for t in trips})


# ---------------------------------------------------------------------------
# Tracks


def test_decode_polyline_reads_otp_encoding() -> None:
    pts = [(40.41682, -3.70379), (40.42, -3.69), (40.4, -3.71)]
    assert decode_polyline(encode(pts)) == pts
    assert decode_polyline("") == []


def test_line_order_puts_numbers_first() -> None:
    names = ["C10", "C4b", "C1", "C4", "C4a", "C8a", "C2"]
    assert sorted(names, key=line_order) == ["C1", "C2", "C4", "C4a", "C4b", "C8a", "C10"]


def test_network_keeps_a_pattern_only_when_it_adds_track() -> None:
    north = [(round(40.20 + i * 0.01, 2), -3.70) for i in range(10)]
    branch = [(40.29, -3.70 + i * 0.01) for i in range(1, 8)]
    data: dict[str, Any] = {
        "routes": [
            {
                "shortName": "C5",
                "patterns": [
                    {
                        "patternGeometry": {"points": encode(north)},
                        "trips": [{"gtfsId": "cercanias:A"}],
                    },
                    # The same track the other way: nothing new.
                    {
                        "patternGeometry": {"points": encode(north[::-1])},
                        "trips": [{"gtfsId": "cercanias:B"}],
                    },
                    # Part of it: nothing new.
                    {
                        "patternGeometry": {"points": encode(north[2:6])},
                        "trips": [{"gtfsId": "cercanias:C"}],
                    },
                    # Out onto a branch: new track.
                    {"patternGeometry": {"points": encode(north[-1:] + branch)}, "trips": []},
                    {"patternGeometry": None, "trips": [{"gtfsId": "cercanias:D"}]},
                ],
            }
        ]
    }
    net = build_network(data)
    assert len(net.line_paths["C5"]) == 2
    assert set(net.trip_track) == {"A", "B", "C"}  # D has no track
    assert net.trip_track["B"] == north[::-1]


def test_segment_path_follows_the_track_between_two_stations() -> None:
    track = [(40.20, -3.70), (40.21, -3.69), (40.22, -3.70), (40.23, -3.69), (40.24, -3.70)]
    a, b = (40.2101, -3.6901), (40.2299, -3.6901)
    path = segment_path(track, a, b)
    assert path is not None
    assert path[0] == [a[1], a[0]] and path[-1] == [b[1], b[0]]  # starts and ends at them
    assert [-3.70, 40.22] in path  # the bend between them
    assert [-3.70, 40.20] not in path and [-3.70, 40.24] not in path


def test_segment_path_refuses_stations_off_or_backwards_on_the_track() -> None:
    track = [(40.20, -3.70), (40.30, -3.70)]
    assert segment_path(track, (40.22, -3.70), (40.25, -3.70)) is not None
    assert segment_path(track, (40.25, -3.70), (40.22, -3.70)) is None  # wrong direction
    assert segment_path(track, (40.22, -3.60), (40.25, -3.70)) is None  # 8 km away
    assert segment_path(track[:1], (40.22, -3.70), (40.25, -3.70)) is None


# ---------------------------------------------------------------------------
# All trains


def test_live_trains_places_every_train_with_its_line_and_track() -> None:
    out = live_trains(recorded(), TIMETABLE, INFO, network_for(*TIMETABLE), NOW)
    assert out.message is None and out.freshness and out.freshness.state == "FRESH"
    by_id = {t.trip_id.partition(":")[2]: t for t in out.trains}
    assert set(by_id) == set(TIMETABLE)
    moving = by_id[C7_MOVING]
    assert moving.status == "between" and moving.kind == "live"
    assert moving.line == C7 and moving.headsign == "Alcalá de Henares"
    assert moving.path is not None and len(moving.path) == 3  # station, bend, station
    a = moving.last_stop
    assert a and a.lon and a.lat and moving.path[0] == [round(a.lon, 5), round(a.lat, 5)]
    assert by_id[C4A_STOPPED].status == "at_stop"
    assert by_id[C8B_STANDING].status == "at_stop"


def test_live_trains_without_tracks_or_line_still_shows_the_trains() -> None:
    out = live_trains(recorded(), TIMETABLE, {}, None, NOW)
    assert len(out.trains) == 3
    moving = next(t for t in out.trains if t.trip_id.endswith(C7_MOVING))
    assert moving.path is None and moving.line is None
    assert moving.headsign == TIMETABLE[C7_MOVING][-1].name  # the terminus


def test_live_trains_leaves_out_waiting_cancelled_and_unknown_trains() -> None:
    snap = recorded()
    snap.not_departed = [C4A_STOPPED]
    snap.trips[C8B_STANDING] = TripRealtime(
        trip_id=C8B_STANDING,
        entity_id="x",
        cancelled=True,
        delay_s=None,
        stop_id=None,
        stop_time=None,
    )
    out = live_trains(snap, TIMETABLE, INFO, None, NOW)
    assert [t.trip_id for t in out.trains] == [f"cercanias:{C7_MOVING}"]
    # The feed has ~100 trains; only those with a timetable here are placed.
    assert len(snap.trips) > len(TIMETABLE)


def test_no_trains_from_outdated_or_missing_data() -> None:
    old = live_trains(recorded(), TIMETABLE, INFO, None, NOW + timedelta(minutes=10))
    assert old.trains == [] and old.message and old.freshness
    assert old.freshness.state == "STALE"
    missing = live_trains(None, TIMETABLE, INFO, None, NOW)
    assert missing.trains == [] and missing.message and missing.freshness
    assert missing.freshness.state == "UNAVAILABLE"


# ---------------------------------------------------------------------------
# Endpoints


class FakeTimetable:
    async def stops(self, natives: list[str]) -> dict[str, Any]:
        return {n: TIMETABLE[n] for n in natives if n in TIMETABLE}

    async def info(self, natives: list[str]) -> dict[str, TrainInfo]:
        return {n: INFO[n] for n in natives if n in INFO}

    async def lines(self) -> dict[str, Line]:
        return {"C7": C7, "C10": C7.model_copy(update={"short_name": "C10"})}


class FakeOtp:
    def __init__(self, data: dict[str, Any] | None) -> None:
        self.data = data
        self.calls = 0

    async def query(self, query: str, timeout_s: float | None = None) -> dict[str, Any]:
        self.calls += 1
        if self.data is None:
            raise OtpUnavailable("down")
        return self.data


OTP_DATA = {
    "routes": [
        {
            "shortName": "C7",
            "patterns": [
                {
                    "patternGeometry": {"points": encode(track_through(C7_MOVING))},
                    "trips": [{"gtfsId": f"cercanias:{C7_MOVING}"}],
                }
            ],
        }
    ]
}


@pytest.fixture
def otp() -> FakeOtp:
    return FakeOtp(OTP_DATA)


@pytest.fixture
def client(otp: FakeOtp) -> Iterator[TestClient]:
    now = datetime.now(UTC)
    snap = recorded(now)
    snap.source_timestamp = now
    cache = NetworkCache()
    app.dependency_overrides[get_train_timetable] = FakeTimetable
    app.dependency_overrides[get_realtime] = lambda: realtime_with(snap)
    app.dependency_overrides[get_otp] = lambda: otp
    app.dependency_overrides[get_network_cache] = lambda: cache
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_live_endpoint(client: TestClient, otp: FakeOtp) -> None:
    body = client.get("/trains/live").json()
    assert body["freshness"]["state"] == "FRESH"
    assert body["poll_after_s"] == 15 and body["source"]
    ids = {t["trip_id"] for t in body["trains"]}
    # The recorded trains, wherever the clock puts them now (live while fresh).
    assert f"cercanias:{C7_MOVING}" in ids or ids <= {f"cercanias:{t}" for t in TIMETABLE}
    client.get("/trains/live")
    assert otp.calls == 1  # the tracks are read from OTP once


def test_lines_endpoint_in_line_order(client: TestClient) -> None:
    body = client.get("/trains/lines").json()
    assert body["available"] is True
    assert [x["line"]["short_name"] for x in body["lines"]] == ["C7", "C10"]
    assert len(body["lines"][0]["paths"]) == 1 and body["lines"][1]["paths"] == []


def test_lines_without_otp_come_without_tracks(client: TestClient, otp: FakeOtp) -> None:
    otp.data = None
    body = client.get("/trains/lines").json()
    assert body["available"] is False
    assert all(x["paths"] == [] for x in body["lines"])
    client.get("/trains/lines")
    assert otp.calls == 1  # not asked again at once after a failure
