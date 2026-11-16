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


def test_accuracy_metrics_daily_results_and_retention() -> None:
    from datetime import date

    from app.realtime.accuracy import Arrival, Prediction, aggregate_and_prune, metrics, store

    day = date(2020, 1, 6)  # far in the past: never mixed with live samples
    base = datetime(2020, 1, 6, 9, 0, tzinfo=UTC)
    trip = "zz_test_trip"

    def pred(i: int, predicted_off_s: int, estimated: bool, waiting: bool = False) -> Prediction:
        sched = base + timedelta(minutes=10 * i)
        return Prediction(
            trip, day, i, f"S{i}", "Z1", 5, sched - timedelta(minutes=5), None, sched,
            sched + timedelta(seconds=predicted_off_s), 0, estimated, None, waiting,
        )  # fmt: skip

    def arr(i: int, late_s: int) -> Arrival:
        sched = base + timedelta(minutes=10 * i)
        return Arrival(trip, day, i, f"S{i}", "Z1", sched, sched + timedelta(seconds=late_s), 10)

    async def scenario(pool: asyncpg.Pool):  # type: ignore[no-untyped-def]
        async def clean() -> None:
            for table in ("prediction_sample", "observed_arrival"):
                await pool.execute(f"DELETE FROM {table} WHERE trip_id = $1", trip)  # noqa: S608
            await pool.execute("DELETE FROM accuracy_daily WHERE day = $1", day)

        await clean()
        try:
            # Actual 60 s and 180 s late; predictions said +0 s and +60 s.
            await store(pool, [pred(1, 0, False), pred(2, 60, True)], [arr(1, 60), arr(2, 180)])
            # A train that had not left its first station: reported apart, never "live est.".
            await store(pool, [pred(3, 0, True, waiting=True)], [arr(3, 240)])
            await store(pool, [pred(1, 30, False)], [arr(1, 999)])  # duplicates: ignored
            rows = await metrics(pool, day, day)
            # Daily results are kept; raw rows past the retention period go. The test rows
            # are from 2020, so `now` is 2020-04-30 (retention 90 days).
            await aggregate_and_prune(pool, datetime(2020, 4, 30, 12, tzinfo=UTC))
            daily = await pool.fetch("SELECT * FROM accuracy_daily WHERE day = $1", day)
            left = await pool.fetchval(
                "SELECT count(*) FROM observed_arrival WHERE trip_id = $1", trip
            )
            return rows, daily, left
        finally:
            await clean()

    rows, daily, left = asyncio.run(_with_pool(scenario))
    by = {(r["line"], r["kind"], r["estimated"]): r for r in rows}
    live = by[("Z1", "prediction", False)]
    assert live["n"] == 1 and live["bias_s"] == 60 and live["pct_1m"] == 1
    est = by[("Z1", "prediction", True)]
    assert est["mae_s"] == 120 and est["pct_1m"] == 0 and est["pct_2m"] == 1
    waiting = by[("Z1", "not_departed", False)]
    assert waiting["n"] == 1 and waiting["bias_s"] == 240 and waiting["horizon_min"] == 5
    sched = by[("*", "schedule", False)]
    assert sched["n"] == 3 and sched["mae_s"] == 160 and sched["horizon_min"] == 0
    assert {(r["line"], r["kind"]) for r in daily} >= {
        ("Z1", "prediction"),
        ("Z1", "not_departed"),
        ("*", "schedule"),
    }
    assert left == 0
