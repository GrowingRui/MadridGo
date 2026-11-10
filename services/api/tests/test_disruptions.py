"""Disruptions page (`GET /disruptions`, Phase 5), on the Renfe and EMT alerts recorded on
2026-11-09 (tests/fixtures/realtime/). No docker needed: the timetable lookup is faked."""

import asyncio
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Literal

import pytest
from fastapi.testclient import TestClient

from app.disruptions import DisruptionStation, LineLookup, build_disruptions, get_line_lookup
from app.main import app
from app.realtime import board, emt, renfe
from app.realtime.cache import EMT_ALERTS, RENFE_ALERTS, MemoryKV, put_model
from app.realtime.models import AlertSnapshot
from app.realtime.service import Realtime, get_realtime
from app.stops import Line
from tests.realtime_helpers import FIXTURES

NOW = datetime.fromtimestamp(1794246907, UTC)  # 2026-11-09 17:55 UTC, when recorded
COLOURS = {"C3": "952585", "C5": "FECB00", "C9": "915419"}


class FakeLookup(LineLookup):
    def __init__(self) -> None:
        pass

    async def lines(self, feed: str, ids: set[str], by: Literal["id", "name"]) -> list[Line]:
        out = []
        for i in ids:
            name = board.renfe_line_of(i) or i if feed == "cercanias" else i
            if feed == "emt" and name == "C1":
                continue  # pretend the timetable does not know it
            out.append(
                Line(
                    source=feed,
                    route_id=i,
                    short_name=name,
                    long_name=None,
                    mode="rail" if feed == "cercanias" else "bus",
                    color=COLOURS.get(name, "0178BC" if feed == "emt" else "75B6E0"),
                    text_color="FFFFFF",
                )
            )
        return out

    async def stations(self, feed: str, native_ids: set[str]) -> dict[str, DisruptionStation]:
        names = {"18000": "Madrid - Atocha Cercanías"}
        return {
            i: DisruptionStation(id=f"renfe:{i}", name=names[i]) for i in native_ids if i in names
        }


def snapshots(retrieved: datetime = NOW) -> list[AlertSnapshot]:
    return [
        renfe.parse_alerts(
            (FIXTURES / "renfe_alerts.pb").read_bytes(), retrieved, {"18000", "35002"}
        ),
        emt.parse_rss((FIXTURES / "emt_rss.xml").read_bytes(), retrieved),
    ]


def build(now: datetime = NOW, retrieved: datetime = NOW):  # type: ignore[no-untyped-def]
    return asyncio.run(build_disruptions(snapshots(retrieved), FakeLookup(), now))


def by_id(result, alert_id: str):  # type: ignore[no-untyped-def]
    return next(d for d in result.disruptions if alert_id in d.id)


def test_line_alert_lists_each_line_once_in_order() -> None:
    strike = by_id(build(), "AVISO_524822")
    names = [ln.short_name for ln in strike.lines]
    # Renfe has one route per direction (10T0001C1, 10T0002C1): one pill per line.
    assert len(names) == len(set(names))
    assert names[:3] == ["C1", "C2", "C3"]
    assert names.index("C9") < names.index("C10")
    assert strike.kind == "line" and strike.operator_name == "Renfe Cercanías"


def test_line_colours_come_from_the_timetable() -> None:
    c5 = by_id(build(), "AVISO_525129")
    assert [(ln.short_name, ln.color) for ln in c5.lines] == [("C5", "FECB00")]


def test_station_alert_names_the_station_with_its_board_id() -> None:
    lift = by_id(build(), "INFO_524808")
    assert lift.kind == "station" and lift.lines == []
    assert lift.stations == [DisruptionStation(id="renfe:18000", name="Madrid - Atocha Cercanías")]
    # A stop the timetable does not know keeps its id as the name, with no board link.
    other = by_id(build(), "INFO_525077")
    assert other.stations == [DisruptionStation(id=None, name="35002")]


def test_upcoming_alerts_within_a_week_are_marked() -> None:
    result = build()
    assert by_id(result, "AVISO_524867").upcoming  # strike on 11 November
    assert not by_id(result, "AVISO_525210").upcoming
    stop_back = by_id(result, "2A48AF80-53A9-4E0D-BB6F-E77BAB98E8FB")  # EMT, from 12 November
    assert stop_back.upcoming
    # Eleven days later, the EMT stop change has ended and are gone.
    later = build(now=NOW + timedelta(days=11))
    assert not any(d.id.endswith("2A48AF80-53A9-4E0D-BB6F-E77BAB98E8FB") for d in later.disruptions)


def test_alerts_further_ahead_than_a_week_are_left_out() -> None:
    result = build(now=NOW - timedelta(days=10))
    assert not any(d.id.endswith("AVISO_524867") for d in result.disruptions)


def test_order_cercanias_lines_then_stations_then_emt() -> None:
    result = build()
    kinds = [(d.operator, d.kind) for d in result.disruptions]
    first_station = kinds.index(("RENFE_CERCANIAS", "station"))
    first_emt = next(i for i, k in enumerate(kinds) if k[0] == "EMT_MADRID")
    assert all(k == ("RENFE_CERCANIAS", "line") for k in kinds[:first_station])
    assert all(k == ("RENFE_CERCANIAS", "station") for k in kinds[first_station:first_emt])
    assert all(k[0] == "EMT_MADRID" for k in kinds[first_emt:])


def test_unknown_emt_line_keeps_its_name_without_colour() -> None:
    event = by_id(build(), "E4AA985C")
    c1 = next(ln for ln in event.lines if ln.short_name == "C1")
    assert c1.color is None and c1.mode == "bus"


def test_sources_are_reported_honestly() -> None:
    fresh = {s.operator: s for s in build().sources}
    assert fresh["RENFE_CERCANIAS"].state == "ok"
    assert fresh["EMT_MADRID"].state == "ok"
    assert fresh["METRO_MADRID"].state == "not_available"
    assert fresh["CRTM"].state == "not_available"
    old = {s.operator: s for s in build(now=NOW + timedelta(minutes=30)).sources}
    assert old["RENFE_CERCANIAS"].state == "stale"
    none = asyncio.run(build_disruptions([], FakeLookup(), NOW))
    assert none.disruptions == []
    assert {s.operator: s.state for s in none.sources}["EMT_MADRID"] == "no_data"


@pytest.fixture
def client() -> Iterator[TestClient]:
    now = datetime.now(UTC)
    kv = MemoryKV()
    renfe_snap, emt_snap = snapshots(now)
    asyncio.run(put_model(kv, RENFE_ALERTS, renfe_snap, 900))
    asyncio.run(put_model(kv, EMT_ALERTS, emt_snap, 900))
    app.dependency_overrides[get_realtime] = lambda: Realtime(kv=kv, emt_service=None)
    app.dependency_overrides[get_line_lookup] = FakeLookup
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_endpoint_in_spanish(client: TestClient) -> None:
    r = client.get("/disruptions", headers={"Accept-Language": "es"})
    assert r.status_code == 200
    body = r.json()
    assert body["disruptions"]
    metro = next(s for s in body["sources"] if s["operator"] == "METRO_MADRID")
    assert "Metro de Madrid no publica" in metro["message"]
