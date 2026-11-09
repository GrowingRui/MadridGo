"""Real-time pieces that need PostGIS: health records, calibration, and the HTTP endpoints."""

import asyncio
import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import create_pool, migrate
from app.main import app
from app.realtime import renfe
from app.realtime.cache import RENFE_ALERTS, RENFE_SNAPSHOT, MemoryKV, put_model
from app.realtime.service import Realtime, get_realtime
from app.realtime.worker import HealthSample, calibrate, record_health
from tests.realtime_helpers import FIXTURES

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(os.getenv("MADRIDGO_INTEGRATION") != "1", reason="needs docker compose"),
]

SOURCE = "zz_test_rt"


async def _with_pool(fn):  # type: ignore[no-untyped-def]
    pool = await create_pool(get_settings().database_url.get_secret_value())
    try:
        async with pool.acquire() as conn:
            await migrate(conn)
        return await fn(pool)
    finally:
        await pool.execute("DELETE FROM adapter_health WHERE source = $1", SOURCE)
        await pool.close()


def test_calibration_suggests_thresholds_from_update_intervals() -> None:
    async def scenario(pool: asyncpg.Pool):  # type: ignore[no-untyped-def]
        await pool.execute("DELETE FROM adapter_health WHERE source = $1", SOURCE)
        start = datetime.now(UTC) - timedelta(hours=2)
        # The feed updates every 20 s, polled every 30 s: one source time is seen twice.
        for i in range(200):
            polled = start + timedelta(seconds=30 * i)
            source_ts = start + timedelta(seconds=20 * ((30 * i) // 20))
            await pool.execute(
                """INSERT INTO adapter_health (source, checked_at, ok, source_ts, feed_age_s)
                   VALUES ($1, $2, true, $3, $4)""",
                SOURCE,
                polled,
                source_ts,
                (polled - source_ts).total_seconds(),
            )
        await record_health(pool, HealthSample(SOURCE, ok=False, error="timeout"))
        return await calibrate(pool, SOURCE)

    result = asyncio.run(_with_pool(scenario))
    assert result.polls == 200  # the failed poll is not used
    assert result.interval_p50_s in (20, 40)
    assert result.interval_p95_s == 40
    assert (result.suggested_fresh_s, result.suggested_delayed_s) == (80, 120)
    assert result.complete is False  # two hours, not seven days


@pytest.fixture
def client() -> Iterator[TestClient]:
    kv = MemoryKV()
    retrieved = datetime.now(UTC)
    alerts = renfe.parse_alerts((FIXTURES / "renfe_alerts.pb").read_bytes(), retrieved, {"18000"})
    trips = renfe.parse_trip_updates((FIXTURES / "renfe_trip_updates.pb").read_bytes(), retrieved)
    asyncio.run(put_model(kv, RENFE_ALERTS, alerts, 900))
    asyncio.run(put_model(kv, RENFE_SNAPSHOT, trips, 900))
    app.dependency_overrides[get_realtime] = lambda: Realtime(kv=kv, emt_service=None)
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_realtime, None)


def test_realtime_status_reports_sources_honestly(client: TestClient) -> None:
    body = client.get("/realtime/status").json()
    by_source = {s["source"]: s for s in body["sources"]}
    # The recorded feed is from 2026-11-09, so by now it is stale, never live.
    assert by_source["renfe_gtfsrt"]["freshness"]["state"] == "STALE"
    assert by_source["renfe_gtfsrt"]["entities"] == 77
    assert by_source["emt_mobilitylabs"]["enabled"] is False
    assert by_source["crtm"]["enabled"] is False
    assert "authorization" in by_source["crtm"]["reason"]


def test_alerts_endpoint_filters_by_line(client: TestClient) -> None:
    every = client.get("/alerts").json()
    assert every and all(a["operator"] == "RENFE_CERCANIAS" for a in every)
    c3 = client.get("/alerts", params={"line": "C3"}).json()
    assert c3 and all(any(r.endswith("C3") for r in a["route_ids"]) for a in c3)
    assert client.get("/alerts", params={"operator": "EMT_MADRID"}).json() == []
