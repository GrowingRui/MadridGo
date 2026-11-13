"""Import a fixture feed into the real database and query it through the API.

The fixture is loaded under its own source key and removed afterwards, so it never
replaces real feeds in a development database.
"""

import asyncio
import os
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import asyncpg
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import migrate
from app.ingest.importer import delete_version, import_feed
from app.ingest.sources import GtfsSource
from app.main import app
from app.realtime.cache import MemoryKV
from app.realtime.service import Realtime, get_realtime
from tests import gtfs_fixture

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(os.getenv("MADRIDGO_INTEGRATION") != "1", reason="needs docker compose"),
]

SOURCE = GtfsSource(
    key="zz_test",
    operator_name="Test operator",
    mode="rail",
    url="https://example.org/gtfs.zip",
    licence_url="https://example.org/licence",
    attribution="Test",
    id_namespace="crtm",  # exercises the par_/est_ station linking
)


async def _run(fn):  # type: ignore[no-untyped-def]
    conn = await asyncpg.connect(get_settings().database_url.get_secret_value())
    try:
        return await fn(conn)
    finally:
        await conn.close()


@pytest.fixture(scope="module")
def imported(tmp_path_factory: pytest.TempPathFactory) -> Iterator[int]:
    path = gtfs_fixture.build(tmp_path_factory.mktemp("gtfs") / "fixture.zip")

    async def load(conn: asyncpg.Connection) -> int:
        await migrate(conn)
        old = await conn.fetch("SELECT id FROM feed_version WHERE source = $1", SOURCE.key)
        for r in old:  # leftovers from an interrupted run
            await conn.execute("UPDATE feed_version SET is_active = false WHERE id = $1", r["id"])
            await delete_version(conn, r["id"])
        result = await import_feed(conn, SOURCE, path, "0" * 64, datetime.now(UTC))
        return result.feed_version_id

    fv = asyncio.run(_run(load))
    yield fv

    async def cleanup(conn: asyncpg.Connection) -> None:
        await conn.execute(
            "UPDATE feed_version SET is_active = false WHERE source = $1", SOURCE.key
        )
        for r in await conn.fetch("SELECT id FROM feed_version WHERE source = $1", SOURCE.key):
            await delete_version(conn, r["id"])
        await conn.execute("DELETE FROM operator WHERE id = $1", SOURCE.key)

    asyncio.run(_run(cleanup))


@pytest.fixture
def client(imported: int) -> Iterator[TestClient]:
    # Boards must not depend on whatever live data the local Redis holds.
    app.dependency_overrides[get_realtime] = lambda: Realtime(kv=MemoryKV(), emt_service=None)
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_realtime, None)


def test_import_records_version_metadata(imported: int) -> None:
    async def q(conn: asyncpg.Connection) -> asyncpg.Record:
        return await conn.fetchrow("SELECT * FROM feed_version WHERE id = $1", imported)

    row = asyncio.run(_run(q))
    assert row["is_active"]
    assert row["feed_version_label"] == "20261102"  # highest of the repeated feed_info rows
    assert str(row["service_end"]) == "2027-12-31"
    assert '"stop_times": 6' in row["row_counts"]


def test_search_is_accent_insensitive_and_groups_station(client: TestClient) -> None:
    resp = client.get("/stops/search", params={"q": "estacion testville"})
    assert resp.status_code == 200
    hits = [s for s in resp.json() if s["id"].startswith("crtm:est_99")]
    assert hits and hits[0]["id"] == "crtm:est_99_1"
    assert hits[0]["name"] == "Estación de Testville"
    assert [ln["short_name"] for ln in hits[0]["lines"]] == ["T1"]
    # The platform is linked to the station, so it is not a separate result.
    assert not any(s["id"] == "crtm:par_99_1" for s in resp.json())


def test_nearby(client: TestClient) -> None:
    resp = client.get("/stops/nearby", params={"lat": 40.40, "lon": -3.70, "radius_m": 100})
    ids = [s["id"] for s in resp.json()]
    assert "crtm:est_99_1" in ids
    assert resp.json()[0]["distance_m"] is not None


def test_departures_scheduled_and_after_midnight(client: TestClient) -> None:
    night = client.get(
        "/stops/crtm:est_99_1/departures",
        params={"at": "2026-11-10T00:00:00+01:00", "minutes": 120},
    )
    assert night.status_code == 200, night.text
    # 01:30 comes from the previous service day's 25:30:00 trip.
    assert [d["time"] for d in night.json()["departures"]] == ["2026-11-10T01:30:00+01:00"]

    morning = client.get(
        "/stops/crtm:est_99_1/departures", params={"at": "2026-11-10T07:30:00", "minutes": 60}
    )
    deps = morning.json()["departures"]
    assert [d["time"][11:16] for d in deps] == ["08:00"]
    assert deps[0]["status"] == "scheduled" and deps[0]["realtime"] is None
    assert morning.json()["data_quality"] == "scheduled"
    # An operator without an authorized real-time source says so (R15).
    statuses = morning.json()["realtime"]
    assert [(st["feed"], st["status"]) for st in statuses] == [("zz_test", "not_available")]
    assert deps[0]["headsign"] == "Terminal Norte"  # from the last stop: trip has no headsign
    assert deps[0]["line"]["color"] == "FF0000"
    assert deps[0]["line"]["mode"] == "rail"


def test_departures_respect_removed_dates(client: TestClient) -> None:
    resp = client.get(
        "/stops/crtm:est_99_1/departures", params={"at": "2026-12-25T07:00:00", "minutes": 120}
    )
    assert resp.json()["departures"] == []


def test_frequency_lines_are_not_shown_as_exact_times(client: TestClient) -> None:
    resp = client.get(
        "/stops/crtm:par_99_2/departures", params={"at": "2026-11-10T07:30:00", "minutes": 60}
    )
    body = resp.json()
    assert body["departures"] == []
    assert len(body["frequencies"]) == 1
    f = body["frequencies"][0]
    assert (f["line"]["short_name"], f["headway_min"]) == ("F2", 10)
    assert f["until_time"][11:16] == "09:59"  # merged with the next window


def test_terminus_has_no_departures(client: TestClient) -> None:
    resp = client.get(
        "/stops/crtm:par_99_3/departures", params={"at": "2026-11-10T07:00:00", "minutes": 240}
    )
    body = resp.json()
    assert body["departures"] == [] and body["frequencies"] == []


def test_unknown_stop_404(client: TestClient) -> None:
    assert client.get("/stops/crtm:nope/departures").status_code == 404


def test_feeds_lists_all_configured_sources(client: TestClient) -> None:
    resp = client.get("/feeds")
    assert resp.status_code == 200
    assert {f["source"] for f in resp.json()} >= {"metro", "cercanias", "emt"}


def test_failed_import_leaves_no_partial_version(tmp_path: Path) -> None:
    bad = tmp_path / "bad.zip"
    gtfs_fixture.build(bad, prefix="")
    import zipfile

    with zipfile.ZipFile(bad, "a") as z:
        z.writestr(
            "stop_times.txt", "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nx,1,2\n"
        )

    async def attempt(conn: asyncpg.Connection) -> int:
        before = await conn.fetchval("SELECT count(*) FROM feed_version")
        with pytest.raises(Exception):  # noqa: B017 - any parse error
            await import_feed(conn, SOURCE, bad, "1" * 64, datetime.now(UTC))
        return before - await conn.fetchval("SELECT count(*) FROM feed_version")

    assert asyncio.run(_run(attempt)) == 0


def test_frequency_line_not_shown_before_it_starts(client: TestClient) -> None:
    resp = client.get(
        "/stops/crtm:par_99_2/departures", params={"at": "2026-11-10T05:00:00", "minutes": 60}
    )
    assert resp.json()["frequencies"] == []  # F2 starts at 07:00


def test_arrivals_at_the_terminus_with_origin(client: TestClient) -> None:
    resp = client.get(
        "/stops/crtm:par_99_3/arrivals", params={"at": "2026-11-10T07:30:00", "minutes": 60}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "arrivals" and body["departures"] == []
    arr = body["arrivals"]
    # The scheduled arrival time, and where the train comes from.
    assert [(a["time"][11:16], a["line"]["short_name"]) for a in arr] == [("08:10", "T1")]
    assert arr[0]["origin"] == "Estación de Testville"
    # Frequency lines arrive "every ~N min", from their first stop.
    [f] = body["frequencies"]
    assert (f["line"]["short_name"], f["headway_min"]) == ("F2", 10)
    assert f["origin"] == "Av. Prueba - Calle Mayor"


def test_no_arrivals_at_a_first_stop(client: TestClient) -> None:
    resp = client.get(
        "/stops/crtm:est_99_1/arrivals", params={"at": "2026-11-10T07:00:00", "minutes": 240}
    )
    body = resp.json()
    assert body["arrivals"] == [] and body["frequencies"] == []


def test_arrivals_after_midnight(client: TestClient) -> None:
    resp = client.get(
        "/stops/crtm:par_99_3/arrivals",
        params={"at": "2026-11-10T01:00:00+01:00", "minutes": 60},
    )
    assert [a["time"] for a in resp.json()["arrivals"]] == ["2026-11-10T01:40:00+01:00"]
