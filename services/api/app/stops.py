"""Stop search, nearby stops, stop details and departure and arrival boards.

`Departure.time` is always the *scheduled* time from the operator's static timetable. Live
information is added next to it (`status`, `realtime`), never in its place, so a client
cannot mistake one for the other. Frequency-based services (Metro, EMT) have no exact
times; they are returned separately as "every ~N min", and EMT live predictions as
`live_arrivals`.

Arrival boards (SBB's "Arrivals") list trips that end or call at a stop, with where they come
from (`origin`); `time` is then the scheduled arrival. EMT live predictions are not repeated
there: they say when the next bus reaches the stop to board it, which is the departure board.
"""

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Annotated, Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.access import ACCESS_FEEDS, accessible, stop_access
from app.dbpool import get_pool
from app.feeds import ExpiryState, expiry_state
from app.i18n import tr
from app.ingest.gtfs import fold
from app.ingest.sources import SOURCES_BY_KEY
from app.realtime import board as live
from app.realtime import emt, renfe
from app.realtime.board import SourceStatus
from app.realtime.models import RealtimeInfo, ServiceAlert
from app.realtime.service import Realtime, get_realtime
from app.timetable import (
    MADRID,
    MODE_ORDER,
    at_service_time,
    display_name,
    line_sort_key,
    mode_for,
    seconds_into,
)

router = APIRouter(tags=["stops"])
Pool = Annotated[asyncpg.Pool, Depends(get_pool)]
RT = Annotated[Realtime, Depends(get_realtime)]
# On a live board, also look this far back so a late train scheduled earlier still shows.
LOOKBACK = timedelta(minutes=45)


class Line(BaseModel):
    source: str
    route_id: str
    short_name: str
    long_name: str | None
    mode: str
    color: str | None
    text_color: str | None


class StopSummary(BaseModel):
    id: str
    name: str
    code: str | None
    lat: float | None
    lon: float | None
    is_station: bool
    modes: list[str]
    lines: list[Line]
    distance_m: float | None = None


class DataNotice(BaseModel):
    source: str
    operator: str
    expiry: ExpiryState
    service_end: date | None
    message: str


class Departure(BaseModel):
    kind: Literal["scheduled"] = "scheduled"  # a timetable row (with or without live data)
    time: datetime  # scheduled time, always
    line: Line
    headsign: str | None
    stop_id: str
    trip_id: str
    wheelchair_accessible: bool | None
    origin: str | None = None  # arrival boards: the trip's first stop
    # scheduled: no usable live data; live: realtime.predicted_time is the best estimate;
    # cancelled: the operator cancelled this trip.
    status: Literal["scheduled", "live", "cancelled"] = "scheduled"
    realtime: RealtimeInfo | None = None

    @property
    def best_time(self) -> datetime:
        if self.realtime and self.realtime.predicted_time:
            return self.realtime.predicted_time
        return self.time


class LiveArrival(BaseModel):
    """A live prediction with no timetable row behind it (EMT buses run by headway)."""

    kind: Literal["live"] = "live"
    line: Line
    headsign: str | None
    stop_id: str
    time: datetime | None  # None: beyond the source's horizon (EMT: more than 45 min)
    distance_m: int | None
    realtime: RealtimeInfo


class FrequencyService(BaseModel):
    kind: Literal["frequency"] = "frequency"
    line: Line
    headsign: str | None
    stop_id: str
    origin: str | None = None  # arrival boards: the trip's first stop
    headway_min: int  # typical gap between vehicles in the window
    from_time: datetime
    until_time: datetime


class StopBoard(BaseModel):
    kind: Literal["departures", "arrivals"] = "departures"
    stop: StopSummary
    generated_at: datetime
    window_start: datetime
    window_end: datetime
    # scheduled: nothing live on this board; partly_live: some entries are live.
    data_quality: Literal["scheduled", "partly_live"] = "scheduled"
    departures: list[Departure]  # empty on an arrival board
    arrivals: list[Departure] = []  # arrival boards only; `time` is the scheduled arrival
    frequencies: list[FrequencyService]
    live_arrivals: list[LiveArrival] = []
    notices: list[DataNotice]
    realtime: list[SourceStatus] = []  # one per operator serving this stop
    alerts: list[ServiceAlert] = []
    # Step-free access to the platforms (app/access.py): Cercanías stations only.
    step_free: bool | None = None


# ---------------------------------------------------------------------------
# Shared SQL fragments

_ACTIVE = "SELECT id, source FROM feed_version WHERE is_active"

_LINES_SQL = f"""
    WITH fv AS ({_ACTIVE})
    SELECT DISTINCT sr.root_id, fv.source, r.native_id, r.short_name, r.long_name,
           r.route_type, r.color, r.text_color
    FROM stop_route sr
    JOIN fv ON fv.id = sr.feed_version_id
    JOIN route r ON r.feed_version_id = sr.feed_version_id AND r.native_id = sr.route_id
    WHERE sr.root_id = ANY($1::text[])
"""


def _line(source: str, r: asyncpg.Record) -> Line:
    return Line(
        source=source,
        route_id=r["native_id"],
        short_name=r["short_name"] or r["native_id"],
        long_name=r["long_name"],
        mode=mode_for(r["route_type"]),
        color=r["color"],
        text_color=r["text_color"],
    )


async def _lines_by_root(pool: asyncpg.Pool, root_ids: list[str]) -> dict[str, list[Line]]:
    out: dict[str, list[Line]] = defaultdict(list)
    seen: set[tuple[str, str, str]] = set()
    for r in await pool.fetch(_LINES_SQL, root_ids):
        line = _line(r["source"], r)
        # Some feeds have one route per direction with the same short name (Cercanías C1).
        key = (r["root_id"], line.source, line.short_name)
        if key not in seen:
            seen.add(key)
            out[r["root_id"]].append(line)
    for lines in out.values():
        lines.sort(key=lambda ln: (MODE_ORDER.get(ln.mode, 9), line_sort_key(ln.short_name)))
    return out


def _summary(r: asyncpg.Record, lines: list[Line]) -> StopSummary:
    modes = sorted({ln.mode for ln in lines}, key=lambda m: MODE_ORDER.get(m, 9))
    return StopSummary(
        id=r["id"],
        name=display_name(r["name"]),
        code=r["code"],
        lat=r["lat"],
        lon=r["lon"],
        is_station=r["is_station"],
        modes=modes,
        lines=lines,
        distance_m=round(r["distance_m"], 1) if "distance_m" in r.keys() else None,
    )


# ---------------------------------------------------------------------------
# Search and nearby

_SEARCH_SQL = f"""
    WITH fv AS ({_ACTIVE})
    SELECT s.id, min(s.name) AS name, min(s.code) AS code, avg(s.lat) AS lat, avg(s.lon) AS lon,
           bool_or(s.location_type = 1) AS is_station,
           max(word_similarity($1, s.search_name)) AS sim,
           bool_or(s.search_name LIKE $1 || '%') AS is_prefix,
           bool_or(s.code = $2) AS code_match
    FROM stop s JOIN fv ON fv.id = s.feed_version_id
    WHERE s.location_type IN (0, 1) AND s.parent_id IS NULL
      AND ($1 <% s.search_name OR s.search_name LIKE '%' || $1 || '%' OR s.code = $2)
    GROUP BY s.id
    ORDER BY sim DESC
    LIMIT 80
"""


def _rank(r: asyncpg.Record, lines: list[Line]) -> float:
    """Higher is better: text match first, then stations, rail and busy stops."""
    score = float(r["sim"])
    if r["code_match"]:
        score += 1.0
    if r["is_prefix"]:
        score += 0.25
    if r["is_station"]:
        score += 0.3
    best_mode = min((MODE_ORDER.get(ln.mode, 9) for ln in lines), default=9)
    score += {0: 0.25, 1: 0.25, 2: 0.2}.get(best_mode, 0.0)
    score += min(len(lines), 10) * 0.01
    if not lines:  # a stop no trip serves today is a poor answer
        score -= 0.5
    return score


@router.get("/stops/search", response_model=list[StopSummary])
async def search_stops(
    pool: Pool,
    q: Annotated[str, Query(min_length=2, max_length=80)],
    limit: Annotated[int, Query(ge=1, le=50)] = 15,
) -> list[StopSummary]:
    """Find stops and stations by name (accent-insensitive, typo-tolerant) or stop code."""
    term = fold(q)
    rows = await pool.fetch(_SEARCH_SQL, term, q.strip())
    lines = await _lines_by_root(pool, [r["id"] for r in rows])
    ranked = sorted(rows, key=lambda r: _rank(r, lines.get(r["id"], [])), reverse=True)
    return [_summary(r, lines.get(r["id"], [])) for r in ranked[:limit]]


_NEARBY_SQL = f"""
    WITH fv AS ({_ACTIVE}),
    here AS (SELECT ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography AS g)
    SELECT s.id, min(s.name) AS name, min(s.code) AS code, avg(s.lat) AS lat, avg(s.lon) AS lon,
           bool_or(s.location_type = 1) AS is_station,
           min(ST_Distance(s.geom, here.g)) AS distance_m
    FROM stop s JOIN fv ON fv.id = s.feed_version_id, here
    WHERE s.location_type IN (0, 1) AND s.parent_id IS NULL
      AND ST_DWithin(s.geom, here.g, $3)
    GROUP BY s.id
    ORDER BY distance_m
    LIMIT $4
"""


@router.get("/stops/nearby", response_model=list[StopSummary])
async def nearby_stops(
    pool: Pool,
    lat: Annotated[float, Query(ge=39.8, le=41.2)],
    lon: Annotated[float, Query(ge=-4.6, le=-3.0)],
    radius_m: Annotated[int, Query(ge=50, le=2000)] = 500,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> list[StopSummary]:
    """Stops within radius_m of a point in the Community of Madrid, nearest first."""
    rows = await pool.fetch(_NEARBY_SQL, lat, lon, radius_m, limit)
    lines = await _lines_by_root(pool, [r["id"] for r in rows])
    return [_summary(r, lines.get(r["id"], [])) for r in rows]


# ---------------------------------------------------------------------------
# Stop details and departures

_STOP_SQL = f"""
    WITH fv AS ({_ACTIVE})
    SELECT s.id, min(s.name) AS name, min(s.code) AS code, avg(s.lat) AS lat, avg(s.lon) AS lon,
           bool_or(s.location_type = 1) AS is_station,
           array_agg(DISTINCT fv.source) AS sources
    FROM stop s JOIN fv ON fv.id = s.feed_version_id
    WHERE s.id = $1
    GROUP BY s.id
"""

# Active services on a date: calendar days in range minus removals, plus additions.
_SERVICES_CTE = """
    services AS MATERIALIZED (
        SELECT c.feed_version_id, c.service_id
        FROM service_calendar c JOIN fv ON fv.id = c.feed_version_id
        WHERE $2::date BETWEEN c.start_date AND c.end_date AND c.days[$3::int]
          AND NOT EXISTS (
              SELECT 1 FROM service_calendar_date x
              WHERE x.feed_version_id = c.feed_version_id AND x.service_id = c.service_id
                AND x.date = $2::date AND x.exception_type = 2)
        UNION
        SELECT x.feed_version_id, x.service_id
        FROM service_calendar_date x JOIN fv ON fv.id = x.feed_version_id
        WHERE x.date = $2::date AND x.exception_type = 1
    )
"""

_STOPS_CTE = """
    stops AS MATERIALIZED (
        SELECT s.feed_version_id, s.native_id, s.id
        FROM stop s JOIN fv ON fv.id = s.feed_version_id
        WHERE (s.root_id = $1 OR s.id = $1) AND s.location_type = 0
    )
"""

# The MATERIALIZED CTEs fix the join order: first this stop's rows (small, indexed),
# then trips and today's services. Left to itself the planner started from every trip
# running today (tens of thousands) and took ~1 s per board.
Kind = Literal["departures", "arrivals"]

# The trip's first stop: its name is the origin on an arrival board, its time anchors
# frequency windows (frequencies.txt counts from the first stop).
_FIRST_STOP = """
    JOIN LATERAL (
        SELECT s0.stop_sequence, s0.departure_s, fs.name FROM stop_time s0
        JOIN stop fs ON fs.feed_version_id = s0.feed_version_id AND fs.native_id = s0.stop_id
        WHERE s0.feed_version_id = t.feed_version_id AND s0.trip_id = t.native_id
        ORDER BY s0.stop_sequence LIMIT 1
    ) first ON true
"""


def _board_sql(kind: Kind) -> str:
    """Timetable rows at a stop. Departures: where you can board (not at the terminus);
    arrivals: where you can get off (not at the first stop)."""
    if kind == "departures":
        t_col, no_service, where = (
            "departure_s",
            "pickup_type",
            "c.stop_sequence < t.last_stop_sequence",
        )
    else:
        t_col, no_service, where = (
            "arrival_s",
            "drop_off_type",
            "c.stop_sequence > first.stop_sequence",
        )
    return f"""
    WITH fv AS ({_ACTIVE}), {_SERVICES_CTE}, {_STOPS_CTE},
    cand AS MATERIALIZED (
        SELECT st.feed_version_id, st.trip_id, st.stop_sequence, st.{t_col} AS time_s,
               stops.id AS stop_gid
        FROM stops
        JOIN stop_time st
          ON st.feed_version_id = stops.feed_version_id AND st.stop_id = stops.native_id
        WHERE st.{t_col} BETWEEN $4 AND $5 AND coalesce(st.{no_service}, 0) <> 1
    )
    SELECT fv.source, c.time_s, c.stop_gid AS stop_id, t.native_id AS trip_id,
           coalesce(nullif(t.headsign, ''), last_stop.name) AS headsign,
           first.name AS origin,
           t.wheelchair_accessible,
           r.native_id, r.short_name, r.long_name, r.route_type, r.color, r.text_color
    FROM cand c
    JOIN fv ON fv.id = c.feed_version_id
    JOIN trip t ON t.feed_version_id = c.feed_version_id AND t.native_id = c.trip_id
    JOIN services sv ON sv.feed_version_id = t.feed_version_id AND sv.service_id = t.service_id
    JOIN route r ON r.feed_version_id = t.feed_version_id AND r.native_id = t.route_id
    LEFT JOIN LATERAL (
        SELECT ls.name FROM stop_time lst
        JOIN stop ls ON ls.feed_version_id = lst.feed_version_id AND ls.native_id = lst.stop_id
        WHERE lst.feed_version_id = t.feed_version_id AND lst.trip_id = t.native_id
          AND lst.stop_sequence = t.last_stop_sequence
    ) last_stop ON true
    {_FIRST_STOP}
    WHERE NOT t.is_frequency_based AND {where}
    ORDER BY c.time_s
    LIMIT $6
"""


def _frequencies_sql(kind: Kind) -> str:
    if kind == "departures":
        t_col, where = "departure_s", "c.stop_sequence < t.last_stop_sequence"
    else:
        t_col, where = "arrival_s", "c.stop_sequence > first.stop_sequence"
    return f"""
    WITH fv AS ({_ACTIVE}), {_SERVICES_CTE}, {_STOPS_CTE},
    cand AS MATERIALIZED (
        SELECT st.feed_version_id, st.trip_id, st.stop_sequence,
               coalesce(st.{t_col}, st.departure_s) AS time_s, stops.id AS stop_gid
        FROM stops
        JOIN stop_time st
          ON st.feed_version_id = stops.feed_version_id AND st.stop_id = stops.native_id
        JOIN trip t0 ON t0.feed_version_id = st.feed_version_id AND t0.native_id = st.trip_id
        WHERE t0.is_frequency_based
    )
    SELECT fv.source, c.stop_gid AS stop_id, t.headsign, t.direction_id,
           first.name AS origin,
           f.start_s + (c.time_s - first.departure_s) AS from_s,
           f.end_s + (c.time_s - first.departure_s) AS until_s,
           f.headway_s,
           r.native_id, r.short_name, r.long_name, r.route_type, r.color, r.text_color
    FROM cand c
    JOIN fv ON fv.id = c.feed_version_id
    JOIN trip t ON t.feed_version_id = c.feed_version_id AND t.native_id = c.trip_id
    JOIN services sv ON sv.feed_version_id = t.feed_version_id AND sv.service_id = t.service_id
    JOIN route r ON r.feed_version_id = t.feed_version_id AND r.native_id = t.route_id
    JOIN frequency f ON f.feed_version_id = t.feed_version_id AND f.trip_id = t.native_id
    {_FIRST_STOP}
    WHERE {where}
      AND f.end_s + (c.time_s - first.departure_s) >= $4
      AND f.start_s + (c.time_s - first.departure_s) <= $5
"""


_BOARD_SQL = {k: _board_sql(k) for k in ("departures", "arrivals")}
_FREQUENCIES_SQL = {k: _frequencies_sql(k) for k in ("departures", "arrivals")}


def _notices(
    sources: list[str], service_end: dict[str, date | None], today: date
) -> list[DataNotice]:
    notices = []
    for src_key in sorted(set(sources)):
        src = SOURCES_BY_KEY.get(src_key)
        if src is None:
            continue
        state, days = expiry_state(service_end.get(src_key), today, src.expiry_warning_days)
        if state == "expired":
            msg = tr(
                "notice.expired_board", operator=src.operator_name, end=service_end.get(src_key)
            )
        elif state == "expiring":
            msg = tr("notice.expiring", operator=src.operator_name, days=days)
        else:
            continue
        notices.append(
            DataNotice(
                source=src_key,
                operator=src.operator_name,
                expiry=state,
                service_end=service_end.get(src_key),
                message=msg,
            )
        )
    return notices


def _merge_frequencies(
    rows: list[asyncpg.Record], day: date, now: datetime, end: datetime, kind: Kind = "departures"
) -> list[FrequencyService]:
    """Collapse consecutive frequency windows per line and direction into the current one.

    Directions are told apart by where trips go (departures) or come from (arrivals).

    Only lines with a window overlapping [now, end] are returned; later windows are used
    just to find when frequent service ends.
    """
    groups: dict[tuple[str, str, str | None, str], list[asyncpg.Record]] = defaultdict(list)
    end_field = "headsign" if kind == "departures" else "origin"
    for r in rows:
        groups[(r["source"], r["native_id"], r[end_field], r["stop_id"])].append(r)
    now_s, end_s = seconds_into(day, now), seconds_into(day, end)
    out = []
    for (source, _, _, stop_id), rs in groups.items():
        rs.sort(key=lambda r: r["from_s"])
        # The window running now, else the next one to start within the requested period.
        idx = next(
            (i for i, r in enumerate(rs) if r["until_s"] >= now_s and r["from_s"] <= end_s), None
        )
        if idx is None:
            continue
        current = rs[idx]
        # EMT publishes one window per hour: follow back-to-back windows so "until" is when
        # frequent service really ends, not the end of the current hour.
        until_s = current["until_s"]
        for r in rs[idx + 1 :]:
            if r["from_s"] > until_s + 120:
                break
            until_s = max(until_s, r["until_s"])
        out.append(
            FrequencyService(
                line=_line(source, current),
                headsign=current["headsign"],
                origin=display_name(current["origin"])
                if kind == "arrivals" and current["origin"]
                else None,
                stop_id=stop_id,
                headway_min=max(1, round(current["headway_s"] / 60)),
                from_time=at_service_time(day, current["from_s"]),
                until_time=at_service_time(day, until_s),
            )
        )
    out.sort(key=lambda f: (MODE_ORDER.get(f.line.mode, 9), line_sort_key(f.line.short_name)))
    return out


async def _stop_summary(pool: asyncpg.Pool, stop_id: str) -> tuple[StopSummary, list[str]]:
    row = await pool.fetchrow(_STOP_SQL, stop_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Stop not found")
    lines = await _lines_by_root(pool, [stop_id])
    sources = list(row["sources"]) + [ln.source for ln in lines.get(stop_id, [])]
    return _summary(row, lines.get(stop_id, [])), sources


@router.get("/stops/{stop_id}", response_model=StopSummary)
async def get_stop(pool: Pool, stop_id: str) -> StopSummary:
    summary, _ = await _stop_summary(pool, stop_id)
    return summary


AtParam = Annotated[datetime | None, Query(description="Start time; default now")]
MinutesParam = Annotated[int, Query(ge=5, le=240)]
LimitParam = Annotated[int, Query(ge=1, le=200)]


@router.get("/stops/{stop_id}/departures", response_model=StopBoard)
async def stop_departures(
    pool: Pool,
    rt: RT,
    stop_id: str,
    at: AtParam = None,
    minutes: MinutesParam = 90,
    limit: LimitParam = 40,
) -> StopBoard:
    """Departures from a stop or station (all its platforms) in a time window, with live
    data where MadridGo has an authorized source for the operator."""
    return await _board(pool, rt, stop_id, at, minutes, limit, "departures")


@router.get("/stops/{stop_id}/arrivals", response_model=StopBoard)
async def stop_arrivals(
    pool: Pool,
    rt: RT,
    stop_id: str,
    at: AtParam = None,
    minutes: MinutesParam = 90,
    limit: LimitParam = 40,
) -> StopBoard:
    """Arrivals at a stop or station in a time window, each with where it comes from, and
    Renfe's live delays. Meant for stations; EMT's live bus times are on the departure board."""
    return await _board(pool, rt, stop_id, at, minutes, limit, "arrivals")


async def _board(
    pool: asyncpg.Pool,
    rt: Realtime,
    stop_id: str,
    at: datetime | None,
    minutes: int,
    limit: int,
    kind: Kind,
) -> StopBoard:
    summary, sources = await _stop_summary(pool, stop_id)
    now = datetime.now(MADRID)
    start = (
        (at.astimezone(MADRID) if at and at.tzinfo else at.replace(tzinfo=MADRID)) if at else now
    )
    end = start + timedelta(minutes=minutes)
    has_rail = "cercanias" in sources
    # Live boards (no `at`) look back so delayed trains scheduled before now still appear.
    query_start = start - LOOKBACK if (at is None and has_rail) else start
    query_limit = limit + 150 if query_start < start else limit

    rows: list[Departure] = []
    freq_rows: list[asyncpg.Record] = []
    freq_day = start.date()
    # Trips after midnight belong to the previous service day (times > 24:00:00).
    for day in (start.date() - timedelta(days=1), start.date()):
        a, b = seconds_into(day, query_start), seconds_into(day, end)
        if b < 0:
            continue
        args = (stop_id, day, day.isoweekday(), a, b)
        for r in await pool.fetch(_BOARD_SQL[kind], *args, query_limit):
            rows.append(
                Departure(
                    time=at_service_time(day, r["time_s"]),
                    line=_line(r["source"], r),
                    headsign=display_name(r["headsign"]) if r["headsign"] else None,
                    origin=(
                        display_name(r["origin"]) if kind == "arrivals" and r["origin"] else None
                    ),
                    stop_id=r["stop_id"],
                    trip_id=r["trip_id"],
                    # Only where the operator's data can be trusted (app/access.py).
                    wheelchair_accessible=(
                        accessible(r["wheelchair_accessible"])
                        if r["source"] in ACCESS_FEEDS
                        else None
                    ),
                )
            )
        if day == start.date():
            # Fetch windows to the end of the service day so back-to-back windows can be merged.
            sa = seconds_into(day, start)
            freq_args = (stop_id, day, day.isoweekday(), sa, max(b, 30 * 3600))
            freq_rows = list(await pool.fetch(_FREQUENCIES_SQL[kind], *freq_args))

    statuses: list[SourceStatus] = []
    if has_rail:
        rows, status = await _overlay_renfe(rt, rows, now)
        statuses.append(status)
    rows = [d for d in rows if d.best_time >= start]
    rows.sort(key=lambda d: (d.best_time, d.time))

    live_arrivals: list[LiveArrival] = []
    if "emt" in sources and kind == "departures":
        live_arrivals, status = await _emt_arrivals(rt, summary, now)
        statuses.append(status)
    for src in set(sources) - {"cercanias", "emt"}:
        statuses.append(live.no_realtime_status(src, _operator(src)))
    statuses.sort(key=lambda st: (_feed_order(st.feed), st.feed))

    service_end = {
        r["source"]: r["service_end"]
        for r in await pool.fetch("SELECT source, service_end FROM feed_version WHERE is_active")
    }
    shown = rows[:limit]
    any_live = any(d.status != "scheduled" for d in shown) or bool(live_arrivals)
    return StopBoard(
        kind=kind,
        stop=summary,
        generated_at=now,
        window_start=start,
        window_end=end,
        data_quality="partly_live" if any_live else "scheduled",
        departures=shown if kind == "departures" else [],
        arrivals=shown if kind == "arrivals" else [],
        frequencies=_merge_frequencies(freq_rows, freq_day, start, end, kind),
        live_arrivals=live_arrivals,
        notices=_notices(sources, service_end, now.date()),
        realtime=statuses,
        alerts=await _alerts(rt, summary, shown, now),
        step_free=(await stop_access(pool, [summary.id])).get(summary.id) if has_rail else None,
    )


# ---------------------------------------------------------------------------
# Live overlays


def _feed_order(feed: str) -> int:
    src = SOURCES_BY_KEY.get(feed)
    return MODE_ORDER.get(src.mode, 9) if src else 9


def _operator(feed: str) -> str:
    src = SOURCES_BY_KEY.get(feed)
    return src.operator_name if src else feed


def _native(global_id: str) -> str:
    return global_id.split(":", 1)[-1]


async def _overlay_renfe(
    rt: Realtime, departures: list[Departure], now: datetime
) -> tuple[list[Departure], SourceStatus]:
    snap = await rt.renfe_snapshot()
    fresh = live.renfe_freshness(snap, now)
    out = []
    for d in departures:
        if d.line.source != "cercanias":
            out.append(d)
            continue
        train = live.renfe_train(d.trip_id, _native(d.stop_id), d.time, snap, fresh)
        if train.passed:
            continue
        if train.info is not None:
            label = "cancelled" if train.info.classification == "CANCELLED" else "live"
            d = d.model_copy(update={"status": label, "realtime": train.info})
        out.append(d)
    status = live.live_status(
        "cercanias",
        _operator("cercanias"),
        renfe.SOURCE,
        renfe.ATTRIBUTION,
        fresh,
        snap.retrieved_at if snap else None,
        snap.source_timestamp if snap else None,
    )
    return out, status


async def _emt_arrivals(
    rt: Realtime, summary: StopSummary, now: datetime
) -> tuple[list[LiveArrival], SourceStatus]:
    fetch = await rt.emt_arrivals(_native(summary.id)) if summary.id.startswith("emt:") else None
    data = fetch.data if fetch else None
    fresh = live.emt_freshness(data, now)
    lines = {ln.short_name.upper(): ln for ln in summary.lines if ln.source == "emt"}
    arrivals = []
    for a, when, info in live.emt_live(data, fresh, now):
        line = lines.get(a.line.upper()) or Line(
            source="emt",
            route_id=a.line,
            short_name=a.line,
            long_name=None,
            mode="bus",
            color=None,
            text_color=None,
        )
        arrivals.append(
            LiveArrival(
                line=line,
                headsign=display_name(a.destination) if a.destination else None,
                stop_id=summary.id,
                time=when,
                distance_m=a.distance_m,
                realtime=info,
            )
        )
    status = live.live_status(
        "emt",
        _operator("emt"),
        emt.SOURCE,
        emt.ATTRIBUTION,
        fresh,
        data.retrieved_at if data else None,
        None,
        error=fetch.error if fetch else None,
    )
    return arrivals, status


async def _alerts(
    rt: Realtime, summary: StopSummary, departures: list[Departure], now: datetime
) -> list[ServiceAlert]:
    snapshots = await rt.alert_snapshots()
    if not snapshots:
        return []
    lines_by_feed: dict[str, set[str]] = defaultdict(set)
    for ln in summary.lines:
        lines_by_feed[ln.source].add(ln.short_name)
    ids = {summary.id, *(d.stop_id for d in departures)}
    stops_by_feed = {"cercanias": {_native(s) for s in ids if s.startswith("renfe:")}}
    if summary.id.startswith("emt:"):
        stops_by_feed["emt"] = {_native(summary.id)}
    return live.alerts_for_stop(snapshots, lines_by_feed, stops_by_feed, now)
