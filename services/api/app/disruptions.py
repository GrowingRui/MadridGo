"""Disruptions page (`GET /disruptions`, Phase 5): every current and upcoming operator alert,
with the lines it names (in their colours) and the stations it names, plus an honest list of
which operators publish alerts at all.

Each alert appears once, with all its lines; the app groups and filters them by line. Texts
come as the operators publish them (Spanish), never rewritten.
"""

from datetime import datetime, timedelta
from typing import Annotated, Literal

import asyncpg
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.dbpool import get_pool
from app.i18n import tr
from app.realtime import board, emt, renfe
from app.realtime.models import AlertSnapshot, ServiceAlert
from app.realtime.service import Realtime, get_realtime, now_utc
from app.stops import Line
from app.timetable import MODE_ORDER, display_name, line_sort_key, mode_for

router = APIRouter(tags=["realtime"])
RT = Annotated[Realtime, Depends(get_realtime)]

# Planned works and stop changes are shown this far ahead, marked "upcoming".
UPCOMING = timedelta(days=7)
# The worker polls alerts every 2 min; older than this, the list may be out of date.
ALERTS_STALE_AFTER = timedelta(minutes=10)

# GTFS feed of each alert source (the static feed its route and stop ids belong to).
_FEED = {renfe.ALERTS_SOURCE: "cercanias", emt.RSS_SOURCE: "emt"}
_OPERATOR_NAME = {renfe.OPERATOR: "Renfe Cercanías", emt.OPERATOR: "EMT Madrid"}


class DisruptionStation(BaseModel):
    id: str | None  # the station's board id, when the stop is in the timetable
    name: str


class Disruption(BaseModel):
    id: str  # "<source>:<alert id>"
    source: str
    operator: str
    operator_name: str
    # Whole-line alerts name lines; station alerts (lifts, closed entrances) name stations.
    kind: Literal["line", "station"]
    lines: list[Line]
    stations: list[DisruptionStation]
    header: str | None
    description: str | None
    url: str | None
    cause: str | None
    effect: str | None
    active_from: datetime | None
    active_to: datetime | None
    upcoming: bool  # starts within the next 7 days, not yet in force


class DisruptionSource(BaseModel):
    operator: str
    name: str
    # ok: alerts received recently; stale: last list is old; no_data: nothing received yet;
    # not_available: the operator publishes no alerts MadridGo may use.
    state: Literal["ok", "stale", "no_data", "not_available"]
    retrieved_at: datetime | None
    message: str


class Disruptions(BaseModel):
    generated_at: datetime
    disruptions: list[Disruption]
    sources: list[DisruptionSource]


_LINES = """
    SELECT r.native_id, r.short_name, r.long_name, r.route_type, r.color, r.text_color
    FROM route r JOIN feed_version fv ON fv.id = r.feed_version_id
    WHERE fv.is_active AND fv.source = $1 AND """
_LINES_BY_ID = _LINES + "r.native_id = ANY($2::text[])"
_LINES_BY_NAME = _LINES + "upper(r.short_name) = ANY($2::text[])"


class LineLookup:
    """Names, colours and stations from the active static timetables."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    async def lines(self, feed: str, ids: set[str], by: Literal["id", "name"]) -> list[Line]:
        if not ids:
            return []
        rows = await self.pool.fetch(
            _LINES_BY_ID if by == "id" else _LINES_BY_NAME, feed, sorted(ids)
        )
        return [
            Line(
                source=feed,
                route_id=r["native_id"],
                short_name=r["short_name"] or r["native_id"],
                long_name=r["long_name"],
                mode=mode_for(r["route_type"]),
                color=r["color"],
                text_color=r["text_color"],
            )
            for r in rows
        ]

    async def stations(self, feed: str, native_ids: set[str]) -> dict[str, DisruptionStation]:
        if not native_ids:
            return {}
        rows = await self.pool.fetch(
            """SELECT s.native_id, s.root_id, coalesce(p.name, s.name) AS name
               FROM stop s JOIN feed_version fv ON fv.id = s.feed_version_id
               LEFT JOIN stop p ON p.feed_version_id = s.feed_version_id AND p.id = s.root_id
               WHERE fv.is_active AND fv.source = $1 AND s.native_id = ANY($2::text[])""",
            feed,
            sorted(native_ids),
        )
        return {
            r["native_id"]: DisruptionStation(id=r["root_id"], name=display_name(r["name"]))
            for r in rows
        }


def get_line_lookup(pool: Annotated[asyncpg.Pool, Depends(get_pool)]) -> LineLookup:
    return LineLookup(pool)


def _line_name(source: str, route_id: str) -> str:
    if source == renfe.ALERTS_SOURCE:
        return board.renfe_line_of(route_id) or route_id
    return route_id


def _fallback_line(feed: str, name: str) -> Line:
    """A line the timetable does not know (e.g. an EMT special service): no colour."""
    return Line(
        source=feed,
        route_id=name,
        short_name=name,
        long_name=None,
        mode="rail" if feed == "cercanias" else "bus",
        color=None,
        text_color=None,
    )


async def _resolve_lines(
    lookup: LineLookup, alerts: list[tuple[str, ServiceAlert]]
) -> dict[tuple[str, str], Line]:
    """(source, line name) -> Line, one entry per line (Renfe has one route per direction)."""
    renfe_ids = {r for src, a in alerts if src == renfe.ALERTS_SOURCE for r in a.route_ids}
    emt_names = {r.upper() for src, a in alerts if src == emt.RSS_SOURCE for r in a.route_ids}
    out: dict[tuple[str, str], Line] = {}
    for ln in await lookup.lines("cercanias", renfe_ids, by="id"):
        out.setdefault((renfe.ALERTS_SOURCE, ln.route_id), ln)
    for ln in await lookup.lines("emt", emt_names, by="name"):
        out.setdefault((emt.RSS_SOURCE, ln.short_name.upper()), ln)
    return out


def _source_report(operator: str, snap: AlertSnapshot | None, now: datetime) -> DisruptionSource:
    name = _OPERATOR_NAME[operator]
    if snap is None:
        return DisruptionSource(
            operator=operator,
            name=name,
            state="no_data",
            retrieved_at=None,
            message=tr("disruptions.no_data", operator=name),
        )
    stale = now - snap.retrieved_at > ALERTS_STALE_AFTER
    return DisruptionSource(
        operator=operator,
        name=name,
        state="stale" if stale else "ok",
        retrieved_at=snap.retrieved_at,
        message=tr("disruptions.stale" if stale else "disruptions.ok", operator=name),
    )


def _sort_key(d: Disruption) -> tuple[object, ...]:
    """Operator (Cercanías first), line alerts before station alerts, then by first line;
    in force before upcoming; newest first."""
    first = d.lines[0] if d.lines else None
    return (
        d.operator != renfe.OPERATOR,
        d.kind != "line",
        MODE_ORDER.get(first.mode, 9) if first else 9,
        line_sort_key(first.short_name) if first else (),
        d.stations[0].name if d.stations else "",
        d.upcoming,
        -(d.active_from.timestamp() if d.active_from else 0),
    )


async def build_disruptions(
    snapshots: list[AlertSnapshot], lookup: LineLookup, now: datetime
) -> Disruptions:
    shown: list[tuple[str, ServiceAlert]] = []
    for snap in snapshots:
        for a in snap.alerts:
            if a.active_to and now > a.active_to:
                continue
            if a.active_from and a.active_from > now + UPCOMING:
                continue
            shown.append((snap.source, a))

    lines = await _resolve_lines(lookup, shown)
    renfe_stops = {s for src, a in shown if src == renfe.ALERTS_SOURCE for s in a.stop_ids}
    stations = await lookup.stations("cercanias", renfe_stops)

    out: list[Disruption] = []
    for src, a in shown:
        feed = _FEED.get(src, "emt")
        alert_lines: list[Line] = []
        seen: set[str] = set()
        for r in a.route_ids:
            key = r if src == renfe.ALERTS_SOURCE else r.upper()
            name = _line_name(src, r)
            if name.upper() in seen:
                continue
            seen.add(name.upper())
            alert_lines.append(lines.get((src, key)) or _fallback_line(feed, name))
        alert_lines.sort(key=lambda ln: (MODE_ORDER.get(ln.mode, 9), line_sort_key(ln.short_name)))
        alert_stations = [stations.get(s) or DisruptionStation(id=None, name=s) for s in a.stop_ids]
        out.append(
            Disruption(
                id=f"{a.source}:{a.source_alert_id}",
                source=a.source,
                operator=a.operator,
                operator_name=_OPERATOR_NAME.get(a.operator, a.operator),
                kind="line" if alert_lines else "station",
                lines=alert_lines,
                stations=alert_stations,
                header=a.header,
                description=a.description,
                url=a.url,
                cause=a.cause,
                effect=a.effect,
                active_from=a.active_from,
                active_to=a.active_to,
                upcoming=bool(a.active_from and a.active_from > now),
            )
        )
    out.sort(key=_sort_key)

    by_source = {s.source: s for s in snapshots}
    sources = [
        _source_report(renfe.OPERATOR, by_source.get(renfe.ALERTS_SOURCE), now),
        _source_report(emt.OPERATOR, by_source.get(emt.RSS_SOURCE), now),
        DisruptionSource(
            operator="METRO_MADRID",
            name="Metro de Madrid",
            state="not_available",
            retrieved_at=None,
            message=tr("disruptions.metro"),
        ),
        DisruptionSource(
            operator="CRTM",
            name=tr("disruptions.crtm_name"),
            state="not_available",
            retrieved_at=None,
            message=tr("disruptions.crtm"),
        ),
    ]
    return Disruptions(generated_at=now, disruptions=out, sources=sources)


@router.get("/disruptions", response_model=Disruptions)
async def disruptions(
    rt: RT, lookup: Annotated[LineLookup, Depends(get_line_lookup)]
) -> Disruptions:
    """Current operator alerts (and those starting within 7 days), each with its lines and
    stations, and which operators publish alerts. For the app's Disruptions page."""
    return await build_disruptions(await rt.alert_snapshots(), lookup, now_utc())
