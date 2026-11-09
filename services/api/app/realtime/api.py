"""Real-time endpoints: adapter status (monitoring) and service alerts."""

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.config import Settings, get_settings
from app.realtime import board, emt, renfe
from app.realtime.models import Freshness, ServiceAlert
from app.realtime.resilience import UpstreamStatus
from app.realtime.service import Realtime, crtm_realtime_enabled, get_realtime, now_utc

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
