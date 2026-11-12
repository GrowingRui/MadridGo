"""Where your EMT bus is (app/buses.py), on the response recorded at stop 72 on 2026-11-12."""

import json
from collections.abc import Iterator
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.buses import locate_bus
from app.main import app
from app.realtime import emt
from app.realtime.cache import MemoryKV
from app.realtime.emt import LiveFetch
from app.realtime.models import EmtArrivals
from app.realtime.service import Realtime, get_realtime
from app.timetable import MADRID

from .realtime_helpers import FIXTURES

ANSWERED = datetime(2026, 11, 12, 9, 18, 39, tzinfo=MADRID)


def recorded(at: datetime = ANSWERED) -> EmtArrivals:
    body = json.loads((FIXTURES / "emt_arrivals_recorded.json").read_text(encoding="utf-8"))
    return emt.parse_arrivals("72", body, at)


def without(data: EmtArrivals, vehicle: str) -> EmtArrivals:
    """The same stop once a bus has passed it: EMT no longer lists that bus."""
    return data.model_copy(
        update={"arrivals": [a for a in data.arrivals if a.vehicle_id != vehicle]}
    )


def test_gps_fix_is_parsed_and_implausible_ones_dropped() -> None:
    data = recorded()
    first = data.arrivals[0]
    assert first.vehicle_id == "2307"
    assert (first.lat, first.lon) == (40.41856909027376, -3.6965764140435087)
    body = {
        "code": "00",
        "data": [
            {
                "Arrive": [
                    {
                        "line": "27",
                        "bus": 1,
                        "estimateArrive": 60,
                        "geometry": {"type": "Point", "coordinates": [0, 0]},
                    }
                ]
            }
        ],
    }
    assert emt.parse_arrivals("72", body, ANSWERED).arrivals[0].lat is None


def test_known_bus_on_its_way_to_the_boarding_stop() -> None:
    pos = locate_bus("53", "Cibeles", LiveFetch(recorded()), None, "2307", None, ANSWERED)
    assert pos.status == "approaching"
    assert (pos.vehicle_id, pos.distance_m, pos.seconds) == ("2307", 72, 23)
    assert pos.expected_at == ANSWERED + timedelta(seconds=23)
    assert pos.lat is not None and pos.lon is not None  # its last GPS fix, for the map
    assert pos.freshness is not None and pos.freshness.state == "FRESH"
    assert pos.source == "emt_mobilitylabs"


def test_without_a_bus_id_the_next_bus_of_the_line() -> None:
    pos = locate_bus("27", "Cibeles", LiveFetch(recorded()), None, None, None, ANSWERED)
    assert (pos.status, pos.vehicle_id) == ("approaching", "525")


def test_bus_that_left_the_boarding_stop_is_found_at_the_alighting_stop() -> None:
    board = LiveFetch(without(recorded(), "2307"))
    alight = LiveFetch(recorded())  # the alighting stop lists bus 2307, 72 m to go
    pos = locate_bus("53", "Cibeles", board, alight, "2307", 2500, ANSWERED)
    assert pos.status == "riding"
    assert (pos.distance_m, pos.seconds) == (72, 23)
    assert pos.lat is None  # on the leg the app places it by the metres still to go


def test_bus_further_than_the_leg_is_not_on_the_leg() -> None:
    board = LiveFetch(without(recorded(), "2557"))
    alight = LiveFetch(recorded())  # bus 2557 is 2,565 m from that stop
    pos = locate_bus("150", "Cibeles", board, alight, "2557", 1500, ANSWERED)
    assert (pos.status, pos.reason) == ("unavailable", "not_found")
    assert "Cibeles" in pos.message


def test_old_data_gives_no_position() -> None:
    later = ANSWERED + timedelta(minutes=10)
    pos = locate_bus("53", "Cibeles", LiveFetch(recorded()), None, "2307", None, later)
    assert (pos.status, pos.reason) == ("unavailable", "outdated")
    assert pos.distance_m is None and pos.lat is None


class FakeEmtService:
    def __init__(self, by_stop: dict[str, EmtArrivals]) -> None:
        self.by_stop = by_stop
        self.calls: list[str] = []

    async def get(self, stop_code: str) -> LiveFetch:
        self.calls.append(stop_code)
        return LiveFetch(self.by_stop.get(stop_code))


@pytest.fixture
def service() -> Iterator[FakeEmtService]:
    now = datetime.now(MADRID)
    fake = FakeEmtService({"72": without(recorded(now), "2307"), "100": recorded(now)})
    rt = Realtime(kv=MemoryKV(), emt_service=fake)  # type: ignore[arg-type]
    app.dependency_overrides[get_realtime] = lambda: rt
    yield fake
    app.dependency_overrides.clear()


def test_endpoint_follows_the_bus_onto_the_leg(service: FakeEmtService) -> None:
    r = TestClient(app).get(
        "/buses/position",
        params={"line": "53", "from_stop": "emt:72", "to_stop": "emt:100", "vehicle": "2307"},
    )
    assert r.status_code == 200
    body = r.json()
    assert (body["status"], body["distance_m"], body["poll_after_s"]) == ("riding", 72, 20)
    assert service.calls == ["72", "100"]


def test_endpoint_asks_only_the_boarding_stop_while_the_bus_is_coming(
    service: FakeEmtService,
) -> None:
    r = TestClient(app).get(
        "/buses/position", params={"line": "27", "from_stop": "emt:72", "to_stop": "emt:100"}
    )
    assert r.json()["status"] == "approaching"
    assert service.calls == ["72"]


def test_endpoint_without_emt_or_for_other_stops() -> None:
    app.dependency_overrides[get_realtime] = lambda: Realtime(kv=MemoryKV(), emt_service=None)
    try:
        client = TestClient(app)
        params = {"line": "27", "from_stop": "emt:72", "to_stop": "emt:100"}
        assert client.get("/buses/position", params=params).json()["reason"] == "not_configured"
        params["from_stop"] = "renfe:18000"
        assert client.get("/buses/position", params=params).json()["reason"] == "not_found"
    finally:
        app.dependency_overrides.clear()
