"""The real-time worker: polls feed-style sources and writes snapshots to the shared cache.

Runs as its own process (`python -m app.realtime run`, the `realtime` compose service), so
a slow upstream never blocks API requests and N users never cause N upstream calls.
"""

import asyncio
import logging
import statistics
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import asyncpg
import httpx

from app.realtime import emt, renfe
from app.realtime.cache import (
    EMT_ALERTS,
    KV,
    RENFE_ALERTS,
    RENFE_SNAPSHOT,
    WORKER_STATUS,
    put_model,
)
from app.realtime.models import AlertSnapshot
from app.realtime.resilience import Upstream, UpstreamUnavailable
from app.realtime.service import WorkerStatus

log = logging.getLogger(__name__)

# Snapshots outlive the STALE threshold on purpose (see cache.py).
SNAPSHOT_TTL_S = 15 * 60
ALERTS_TTL_S = 60 * 60
HEALTH_RETENTION_DAYS = 30
FEED_DEADLINE_S = 10.0


@dataclass
class HealthSample:
    source: str
    ok: bool
    latency_ms: float | None = None
    source_ts: datetime | None = None
    feed_age_s: float | None = None
    entity_count: int | None = None
    match_rate: float | None = None
    error: str | None = None


async def record_health(pool: asyncpg.Pool | None, s: HealthSample) -> None:
    if pool is None:
        return
    try:
        await pool.execute(
            """INSERT INTO adapter_health (source, ok, latency_ms, source_ts, feed_age_s,
                   entity_count, match_rate, error)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
            s.source,
            s.ok,
            s.latency_ms,
            s.source_ts,
            s.feed_age_s,
            s.entity_count,
            s.match_rate,
            s.error,
        )
    except (OSError, asyncpg.PostgresError) as exc:
        log.warning("could not record adapter health: %s", type(exc).__name__)


async def _match_rate(pool: asyncpg.Pool | None, trip_ids: list[str]) -> float | None:
    if pool is None or not trip_ids:
        return None
    try:
        found = await pool.fetchval(
            """SELECT count(*) FROM trip t
               JOIN feed_version fv ON fv.id = t.feed_version_id
                AND fv.is_active AND fv.source = 'cercanias'
               WHERE t.native_id = ANY($1::text[])""",
            trip_ids,
        )
    except (OSError, asyncpg.PostgresError):
        return None
    return round(int(found) / len(trip_ids), 4)


async def _madrid_stops(pool: asyncpg.Pool | None) -> set[str]:
    if pool is None:
        return set()
    try:
        rows = await pool.fetch(
            """SELECT s.native_id FROM stop s JOIN feed_version fv
               ON fv.id = s.feed_version_id AND fv.is_active AND fv.source = 'cercanias'"""
        )
    except (OSError, asyncpg.PostgresError):
        return set()
    return {r["native_id"] for r in rows}


@dataclass
class Worker:
    kv: KV
    renfe_up: Upstream
    emt_rss_up: Upstream
    pool: asyncpg.Pool | None = None
    last_poll: dict[str, str] = field(default_factory=dict)

    def _now(self) -> datetime:
        return datetime.now(UTC)

    async def _fetch[T](self, up: Upstream, url: str, parse: Callable[[bytes], T]) -> T:
        """GET and parse a feed. A non-200 answer or a feed that does not parse counts as
        a failure for the circuit breaker, not just a network error."""
        resp = await up.request("GET", url, deadline_s=FEED_DEADLINE_S, judged=True)
        if resp.status_code != 200:
            up.report_failure(f"HTTP {resp.status_code}")
            raise UpstreamUnavailable(f"HTTP {resp.status_code}")
        try:
            result = parse(resp.content)
        except Exception as exc:  # protobuf DecodeError, XML errors, ...
            up.report_failure(f"unparsable feed ({type(exc).__name__})")
            raise UpstreamUnavailable("unparsable feed") from exc
        up.report_success()
        return result

    async def poll_renfe(self) -> HealthSample:
        start = self._now()
        try:
            snap = await self._fetch(
                self.renfe_up,
                renfe.TRIP_UPDATES_URL,
                lambda b: renfe.parse_trip_updates(b, self._now()),
            )
        except UpstreamUnavailable as exc:
            self.last_poll[renfe.SOURCE] = str(exc) or exc.reason
            return HealthSample(renfe.SOURCE, ok=False, error=str(exc) or exc.reason)
        retrieved = snap.retrieved_at

        # Vehicle positions only add platforms and vehicle ids; their failure is not fatal.
        try:
            _, snap.vehicles = await self._fetch(
                self.renfe_up, renfe.VEHICLE_POSITIONS_URL, renfe.parse_vehicle_positions
            )
        except UpstreamUnavailable as exc:
            log.info("vehicle positions skipped: %s", exc)

        await put_model(self.kv, RENFE_SNAPSHOT, snap, SNAPSHOT_TTL_S)
        self.last_poll[renfe.SOURCE] = "ok"
        age = (retrieved - snap.source_timestamp).total_seconds() if snap.source_timestamp else None
        return HealthSample(
            renfe.SOURCE,
            ok=True,
            latency_ms=round((retrieved - start).total_seconds() * 1000, 1),
            source_ts=snap.source_timestamp,
            feed_age_s=age,
            entity_count=len(snap.trips),
            match_rate=await _match_rate(self.pool, list(snap.trips)),
        )

    async def poll_alerts(self) -> list[HealthSample]:
        samples = []
        madrid_stops = await _madrid_stops(self.pool)
        jobs: list[tuple[str, str, Upstream, str, Callable[[bytes], AlertSnapshot]]] = [
            (
                renfe.ALERTS_SOURCE,
                RENFE_ALERTS,
                self.renfe_up,
                renfe.ALERTS_URL,
                lambda b: renfe.parse_alerts(b, self._now(), madrid_stops),
            ),
            (
                emt.RSS_SOURCE,
                EMT_ALERTS,
                self.emt_rss_up,
                emt.RSS_URL,
                lambda b: emt.parse_rss(b, self._now()),
            ),
        ]
        for source, key, up, url, parse in jobs:
            try:
                snap = await self._fetch(up, url, parse)
            except UpstreamUnavailable as exc:
                self.last_poll[source] = str(exc) or exc.reason
                samples.append(HealthSample(source, ok=False, error=str(exc) or exc.reason))
                continue
            await put_model(self.kv, key, snap, ALERTS_TTL_S)
            self.last_poll[source] = "ok"
            samples.append(
                HealthSample(
                    source, ok=True, source_ts=snap.source_timestamp, entity_count=len(snap.alerts)
                )
            )
        return samples

    async def publish_status(self) -> None:
        status = WorkerStatus(
            updated_at=self._now(),
            upstreams=[self.renfe_up.status(), self.emt_rss_up.status()],
            last_poll=dict(self.last_poll),
        )
        await put_model(self.kv, WORKER_STATUS, status, SNAPSHOT_TTL_S)

    async def prune(self) -> None:
        if self.pool is None:
            return
        try:
            await self.pool.execute(
                "DELETE FROM adapter_health WHERE checked_at < now() - make_interval(days => $1)",
                HEALTH_RETENTION_DAYS,
            )
        except (OSError, asyncpg.PostgresError):
            pass


async def run_forever(worker: Worker, renfe_every_s: float, alerts_every_s: float) -> None:
    loop = asyncio.get_running_loop()
    next_alerts = next_prune = loop.time()
    while True:
        started = loop.time()
        sample = await worker.poll_renfe()
        await record_health(worker.pool, sample)
        log.info(
            "renfe ok=%s trips=%s age=%s match=%s err=%s",
            sample.ok,
            sample.entity_count,
            sample.feed_age_s,
            sample.match_rate,
            sample.error,
        )
        if started >= next_alerts:
            for s in await worker.poll_alerts():
                await record_health(worker.pool, s)
            next_alerts = started + alerts_every_s
        if started >= next_prune:
            await worker.prune()
            next_prune = started + 24 * 3600
        try:
            await worker.publish_status()
        except Exception as exc:  # noqa: BLE001 - Redis hiccup: try again next round
            log.warning("could not publish worker status: %s", type(exc).__name__)
        await asyncio.sleep(max(1.0, renfe_every_s - (loop.time() - started)))


# --- Calibration ---------------------------------------------------------------------------


@dataclass
class Calibration:
    source: str
    polls: int
    distinct_updates: int
    span_hours: float
    interval_p50_s: float | None
    interval_p95_s: float | None
    interval_p99_s: float | None
    age_p95_s: float | None
    suggested_fresh_s: int | None
    suggested_delayed_s: int | None
    complete: bool  # at least 7 days of data


def _pct(values: list[float], p: float) -> float | None:
    if len(values) < 2:
        return values[0] if values else None
    return statistics.quantiles(values, n=100, method="inclusive")[round(p) - 1]


async def calibrate(pool: asyncpg.Pool, source: str, days: int = 7) -> Calibration:
    rows = await pool.fetch(
        """SELECT checked_at, source_ts, feed_age_s FROM adapter_health
           WHERE source = $1 AND ok AND checked_at > now() - make_interval(days => $2)
           ORDER BY checked_at""",
        source,
        days,
    )
    stamps = sorted({r["source_ts"] for r in rows if r["source_ts"] is not None})
    intervals = [(b - a).total_seconds() for a, b in zip(stamps, stamps[1:], strict=False)]
    ages = [float(r["feed_age_s"]) for r in rows if r["feed_age_s"] is not None]
    span = (rows[-1]["checked_at"] - rows[0]["checked_at"]) if rows else timedelta(0)
    p95, p99 = _pct(intervals, 95), _pct(intervals, 99)
    return Calibration(
        source=source,
        polls=len(rows),
        distinct_updates=len(stamps),
        span_hours=round(span.total_seconds() / 3600, 1),
        interval_p50_s=_pct(intervals, 50),
        interval_p95_s=p95,
        interval_p99_s=p99,
        age_p95_s=_pct(ages, 95),
        suggested_fresh_s=round(p95 * 2) if p95 is not None else None,
        suggested_delayed_s=round(p99 * 3) if p99 is not None else None,
        complete=span >= timedelta(days=7),
    )


def make_upstreams(http: httpx.AsyncClient) -> tuple[Upstream, Upstream]:
    return Upstream(name=renfe.SOURCE, client=http), Upstream(name=emt.RSS_SOURCE, client=http)
