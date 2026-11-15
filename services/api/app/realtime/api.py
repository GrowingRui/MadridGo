"""Real-time endpoints: adapter status (monitoring), service alerts and how accurate the
live times have been (`GET /accuracy`)."""

import time
from datetime import date, datetime
from typing import Annotated, Literal

import asyncpg
from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel

from app.config import Settings, get_settings
from app.dbpool import get_pool
from app.disruptions import LineLookup, fallback_line, get_line_lookup
from app.realtime import accuracy, board, emt, renfe
from app.realtime.models import Freshness, ServiceAlert
from app.realtime.resilience import UpstreamStatus
from app.realtime.service import Realtime, crtm_realtime_enabled, get_realtime, now_utc
from app.stops import Line
from app.timetable import MADRID, line_sort_key

router = APIRouter(tags=["realtime"])
RT = Annotated[Realtime, Depends(get_realtime)]


class SourceReport(BaseModel):
    source: str
    operator: str
    kind: Literal["feed", "on_demand"]
    enabled: bool
    reason: str | None = None  # why it is disabled
    freshness: Freshness | None = None
    source_timestamp: datetime | None = None
    retrieved_at: datetime | None = None
    entities: int | None = None
    last_poll: str | None = None


class RealtimeStatus(BaseModel):
    checked_at: datetime
    worker_seen_at: datetime | None
    sources: list[SourceReport]
    upstreams: list[UpstreamStatus]


@router.get("/realtime/status", response_model=RealtimeStatus)
async def realtime_status(
    rt: RT, settings: Annotated[Settings, Depends(get_settings)]
) -> RealtimeStatus:
    """What each real-time source is doing right now: freshness, entity counts, breaker
    state and the last poll result. For monitoring; no personal data."""
    now = now_utc()
    snap = await rt.renfe_snapshot()
    worker = await rt.worker_status()
    last = worker.last_poll if worker else {}
    alerts = {a.source: a for a in await rt.alert_snapshots()}
    sources = [
        SourceReport(
            source=renfe.SOURCE,
            operator="Renfe Cercanías",
            kind="feed",
            enabled=True,
            freshness=board.renfe_freshness(snap, now),
            source_timestamp=snap.source_timestamp if snap else None,
            retrieved_at=snap.retrieved_at if snap else None,
            entities=len(snap.trips) if snap else None,
            last_poll=last.get(renfe.SOURCE),
        ),
        SourceReport(
            source=renfe.ALERTS_SOURCE,
            operator="Renfe Cercanías",
            kind="feed",
            enabled=True,
            source_timestamp=alerts[renfe.ALERTS_SOURCE].source_timestamp
            if renfe.ALERTS_SOURCE in alerts
            else None,
            retrieved_at=alerts[renfe.ALERTS_SOURCE].retrieved_at
            if renfe.ALERTS_SOURCE in alerts
            else None,
            entities=len(alerts[renfe.ALERTS_SOURCE].alerts)
            if renfe.ALERTS_SOURCE in alerts
            else None,
            last_poll=last.get(renfe.ALERTS_SOURCE),
        ),
        SourceReport(
            source=emt.SOURCE,
            operator="EMT Madrid",
            kind="on_demand",
            enabled=rt.emt_service is not None,
            reason=None if rt.emt_service is not None else "EMT credentials not configured",
        ),
        SourceReport(
            source=emt.RSS_SOURCE,
            operator="EMT Madrid",
            kind="feed",
            enabled=True,
            retrieved_at=alerts[emt.RSS_SOURCE].retrieved_at if emt.RSS_SOURCE in alerts else None,
            entities=len(alerts[emt.RSS_SOURCE].alerts) if emt.RSS_SOURCE in alerts else None,
            last_poll=last.get(emt.RSS_SOURCE),
        ),
        SourceReport(
            source="crtm",
            operator="CRTM (interurban and urban buses, Metro)",
            kind="feed",
            enabled=crtm_realtime_enabled(settings),
            reason="Awaiting written authorization from CRTM",
        ),
    ]
    upstreams = [u.status() for u in rt.upstreams] + (worker.upstreams if worker else [])
    return RealtimeStatus(
        checked_at=now,
        worker_seen_at=worker.updated_at if worker else None,
        sources=sources,
        upstreams=upstreams,
    )


@router.get("/alerts", response_model=list[ServiceAlert])
async def service_alerts(
    rt: RT,
    operator: Annotated[
        Literal["RENFE_CERCANIAS", "EMT_MADRID"] | None, Query(description="Filter by operator")
    ] = None,
    line: Annotated[str | None, Query(max_length=20, description="Line, e.g. C4a or 27")] = None,
) -> list[ServiceAlert]:
    """Active service alerts (Renfe GTFS-RT Alerts, EMT incidents RSS)."""
    now = now_utc()
    out = []
    for snap in await rt.alert_snapshots():
        for a in snap.alerts:
            if not a.is_active(now) or (operator and a.operator != operator):
                continue
            if line:
                names = {(board.renfe_line_of(r) or r).lower() for r in a.route_ids}
                if line.lower() not in names:
                    continue
            out.append(a)
    out.sort(key=lambda a: a.active_from or now, reverse=True)
    return out


class AccuracyRow(BaseModel):
    """One group of matched arrivals. Errors are actual arrival - time shown, in seconds;
    the pct_* are shares (0-1) within 1, 2 and 5 minutes."""

    line: str  # "*" = all lines together
    kind: Literal["prediction", "schedule"]  # schedule = the timetable alone (adherence)
    horizon_min: int | None  # minutes before the arrival the time was shown; None for schedule
    estimated: bool  # "Live · est.": delay carried forward from the stop Renfe names
    n: int
    mae_s: float
    median_abs_s: float
    p90_abs_s: float
    bias_s: float  # > 0: trains came later than shown
    pct_1m: float
    pct_2m: float
    pct_5m: float


class AccuracyReport(BaseModel):
    operator: str
    operator_name: str
    first_day: date
    last_day: date
    days: int
    days_with_data: int
    provisional: bool
    min_sample: int
    min_days: int
    generated_at: datetime
    lines: list[Line]  # the lines with figures, in line order, with their colours
    rows: list[AccuracyRow]


# The query takes ~0.3 s for one day of data and grows with the period: one answer per
# period is kept this long, which is also how long clients may cache it.
ACCURACY_TTL_S = 300
_accuracy_cache: dict[tuple[date, int], tuple[float, AccuracyReport]] = {}


@router.get("/accuracy", response_model=AccuracyReport)
async def live_accuracy(
    response: Response,
    pool: Annotated[asyncpg.Pool, Depends(get_pool)],
    lookup: Annotated[LineLookup, Depends(get_line_lookup)],
    days: Annotated[int, Query(ge=1, le=accuracy.RETENTION_DAYS)] = 7,
) -> AccuracyReport:
    """How close Renfe Cercanías live times came to the real arrivals over the last `days`
    service days (RELIABILITY_STRATEGY.md §4), for all lines ("*") and per line, plus how
    well trains kept the timetable. Provisional until there is enough data."""
    now = now_utc()
    last = now.astimezone(MADRID).date()
    response.headers["Cache-Control"] = f"public, max-age={ACCURACY_TTL_S}"
    cached = _accuracy_cache.get((last, days))
    if cached and cached[0] > time.monotonic():
        return cached[1]
    rep = await accuracy.report(pool, last, days)
    names = {r["line"] for r in rep.rows if r["line"] != "*"}
    known: dict[str, Line] = {}
    # The lookup compares names in upper case (C4a is C4A there).
    for ln in await lookup.lines("cercanias", {n.upper() for n in names}, by="name"):
        known.setdefault(ln.short_name.upper(), ln)  # Renfe has one route per direction
    lines = sorted(
        (known.get(n.upper()) or fallback_line("cercanias", n) for n in names),
        key=lambda ln: line_sort_key(ln.short_name),
    )
    out = AccuracyReport(
        operator=renfe.OPERATOR,
        operator_name="Renfe Cercanías",
        first_day=rep.first,
        last_day=rep.last,
        days=days,
        days_with_data=rep.days_with_data,
        provisional=rep.provisional,
        min_sample=accuracy.MIN_SAMPLE,
        min_days=accuracy.MIN_DAYS,
        generated_at=now,
        lines=lines,
        rows=[
            AccuracyRow(
                line=r["line"],
                kind=r["kind"],
                horizon_min=r["horizon_min"] if r["kind"] == "prediction" else None,
                estimated=r["estimated"],
                n=r["n"],
                mae_s=round(r["mae_s"], 1),
                median_abs_s=round(r["median_abs_s"], 1),
                p90_abs_s=round(r["p90_abs_s"], 1),
                bias_s=round(r["bias_s"], 1),
                pct_1m=round(r["pct_1m"], 4),
                pct_2m=round(r["pct_2m"], 4),
                pct_5m=round(r["pct_5m"], 4),
            )
            for r in rep.rows
        ],
    )
    for key in [k for k, (exp, _) in _accuracy_cache.items() if exp <= time.monotonic()]:
        del _accuracy_cache[key]
    _accuracy_cache[(last, days)] = (time.monotonic() + ACCURACY_TTL_S, out)
    return out
