"""Feed status: which static data versions are active and when they expire."""

from datetime import date
from typing import Literal

import asyncpg
from pydantic import BaseModel

from app.ingest.sources import GTFS_SOURCES, SOURCES_BY_KEY

ExpiryState = Literal["ok", "expiring", "expired"]


def expiry_state(
    service_end: date | None, today: date, warning_days: int
) -> tuple[ExpiryState, int]:
    """Classify a feed by its last service day. Returns (state, days until it ends)."""
    if service_end is None:
        return "expired", 0
    days = (service_end - today).days
    if days < 0:
        return "expired", days
    return ("expiring" if days <= warning_days else "ok"), days


class FeedStatus(BaseModel):
    source: str
    operator: str
    mode: str
    imported: bool
    feed_version_id: int | None = None
    feed_version_label: str | None = None
    service_start: date | None = None
    service_end: date | None = None
    expiry: ExpiryState | None = None
    days_left: int | None = None
    validation_status: str | None = None
    attribution: str
    licence_url: str


async def feed_statuses(pool: asyncpg.Pool, today: date) -> list[FeedStatus]:
    rows = await pool.fetch(
        """SELECT source, id, feed_version_label, service_start, service_end, validation_status
           FROM feed_version WHERE is_active"""
    )
    by_source = {r["source"]: r for r in rows}
    out = []
    for src in GTFS_SOURCES:
        r = by_source.get(src.key)
        base = FeedStatus(
            source=src.key,
            operator=src.operator_name,
            mode=src.mode,
            imported=r is not None,
            attribution=src.attribution,
            licence_url=src.licence_url,
        )
        if r is not None:
            state, days = expiry_state(r["service_end"], today, src.expiry_warning_days)
            base = base.model_copy(
                update={
                    "feed_version_id": r["id"],
                    "feed_version_label": r["feed_version_label"],
                    "service_start": r["service_start"],
                    "service_end": r["service_end"],
                    "expiry": state,
                    "days_left": days,
                    "validation_status": r["validation_status"],
                }
            )
        out.append(base)
    return out


def source_mode(source: str) -> str:
    src = SOURCES_BY_KEY.get(source)
    return src.mode if src else "unknown"
