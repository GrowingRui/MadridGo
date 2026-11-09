"""Stop search, nearby stops, stop details and scheduled departures (static GTFS only).

Every time returned here is a *scheduled* time from the operator's static timetable.
Frequency-based services (Metro, EMT) have no exact times; they are returned
separately as "every ~N min" so the app never shows a headway estimate as a time.
"""

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Annotated, Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.dbpool import get_pool
from app.feeds import ExpiryState, expiry_state
from app.ingest.gtfs import fold
from app.ingest.sources import SOURCES_BY_KEY
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
    kind: Literal["scheduled"] = "scheduled"
    time: datetime
    line: Line
    headsign: str | None
    stop_id: str
    trip_id: str
    wheelchair_accessible: bool | None


class FrequencyService(BaseModel):
    kind: Literal["frequency"] = "frequency"
    line: Line
    headsign: str | None
    stop_id: str
    headway_min: int  # typical gap between vehicles in the window
    from_time: datetime
    until_time: datetime


class StopBoard(BaseModel):
    stop: StopSummary
    generated_at: datetime
    window_start: datetime
    window_end: datetime
    data_quality: Literal["scheduled"] = "scheduled"
    departures: list[Departure]
    frequencies: list[FrequencyService]
    notices: list[DataNotice]


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
_DEPARTURES_SQL = f"""
    WITH fv AS ({_ACTIVE}), {_SERVICES_CTE}, {_STOPS_CTE},
    cand AS MATERIALIZED (
        SELECT st.feed_version_id, st.trip_id, st.stop_sequence, st.departure_s,
               stops.id AS stop_gid
        FROM stops
        JOIN stop_time st
          ON st.feed_version_id = stops.feed_version_id AND st.stop_id = stops.native_id
        WHERE st.departure_s BETWEEN $4 AND $5 AND coalesce(st.pickup_type, 0) <> 1
    )
    SELECT fv.source, c.departure_s, c.stop_gid AS stop_id, t.native_id AS trip_id,
           coalesce(nullif(t.headsign, ''), last_stop.name) AS headsign,
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
    WHERE NOT t.is_frequency_based
      AND c.stop_sequence < t.last_stop_sequence
    ORDER BY c.departure_s
    LIMIT $6
"""

_FREQUENCIES_SQL = f"""
    WITH fv AS ({_ACTIVE}), {_SERVICES_CTE}, {_STOPS_CTE},
    cand AS MATERIALIZED (
        SELECT st.feed_version_id, st.trip_id, st.stop_sequence, st.departure_s,
               stops.id AS stop_gid
        FROM stops
        JOIN stop_time st
          ON st.feed_version_id = stops.feed_version_id AND st.stop_id = stops.native_id
        JOIN trip t0 ON t0.feed_version_id = st.feed_version_id AND t0.native_id = st.trip_id
        WHERE t0.is_frequency_based AND st.stop_sequence < t0.last_stop_sequence
    )
    SELECT fv.source, c.stop_gid AS stop_id, t.headsign, t.direction_id,
           f.start_s + (c.departure_s - first.departure_s) AS from_s,
           f.end_s + (c.departure_s - first.departure_s) AS until_s,
           f.headway_s,
           r.native_id, r.short_name, r.long_name, r.route_type, r.color, r.text_color
    FROM cand c
    JOIN fv ON fv.id = c.feed_version_id
    JOIN trip t ON t.feed_version_id = c.feed_version_id AND t.native_id = c.trip_id
    JOIN services sv ON sv.feed_version_id = t.feed_version_id AND sv.service_id = t.service_id
    JOIN route r ON r.feed_version_id = t.feed_version_id AND r.native_id = t.route_id
    JOIN frequency f ON f.feed_version_id = t.feed_version_id AND f.trip_id = t.native_id
    JOIN LATERAL (
        SELECT s0.departure_s FROM stop_time s0
        WHERE s0.feed_version_id = t.feed_version_id AND s0.trip_id = t.native_id
        ORDER BY s0.stop_sequence LIMIT 1
    ) first ON true
    WHERE f.end_s + (c.departure_s - first.departure_s) >= $4
      AND f.start_s + (c.departure_s - first.departure_s) <= $5
"""


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
            msg = (
                f"The official {src.operator_name} timetable expired on "
                f"{service_end.get(src_key)}. No scheduled times are available for it."
            )
        elif state == "expiring":
            msg = f"The {src.operator_name} timetable ends in {days} days."
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
    rows: list[asyncpg.Record], day: date, now: datetime, end: datetime
) -> list[FrequencyService]:
    """Collapse consecutive frequency windows per line and direction into the current one.

    Only lines with a window overlapping [now, end] are returned; later windows are used
    just to find when frequent service ends.
    """
    groups: dict[tuple[str, str, str | None, str], list[asyncpg.Record]] = defaultdict(list)
    for r in rows:
        groups[(r["source"], r["native_id"], r["headsign"], r["stop_id"])].append(r)
    now_s, end_s = seconds_into(day, now), seconds_into(day, end)
    out = []
    for (source, _, headsign, stop_id), rs in groups.items():
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
                headsign=headsign,
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


@router.get("/stops/{stop_id}/departures", response_model=StopBoard)
async def stop_departures(
    pool: Pool,
    stop_id: str,
    at: Annotated[datetime | None, Query(description="Start time; default now")] = None,
    minutes: Annotated[int, Query(ge=5, le=240)] = 90,
    limit: Annotated[int, Query(ge=1, le=200)] = 40,
) -> StopBoard:
    """Scheduled departures from a stop or station (all its platforms) in a time window."""
    summary, sources = await _stop_summary(pool, stop_id)
    now = datetime.now(MADRID)
    start = (
        (at.astimezone(MADRID) if at and at.tzinfo else at.replace(tzinfo=MADRID)) if at else now
    )
    end = start + timedelta(minutes=minutes)

    departures: list[Departure] = []
    freq_rows: list[asyncpg.Record] = []
    freq_day = start.date()
    # Trips after midnight belong to the previous service day (times > 24:00:00).
    for day in (start.date() - timedelta(days=1), start.date()):
        a, b = seconds_into(day, start), seconds_into(day, end)
        if b < 0:
            continue
        args = (stop_id, day, day.isoweekday(), a, b)
        for r in await pool.fetch(_DEPARTURES_SQL, *args, limit):
            departures.append(
                Departure(
                    time=at_service_time(day, r["departure_s"]),
                    line=_line(r["source"], r),
                    headsign=display_name(r["headsign"]) if r["headsign"] else None,
                    stop_id=r["stop_id"],
                    trip_id=r["trip_id"],
                    wheelchair_accessible=(
                        None
                        if r["wheelchair_accessible"] in (None, 0)
                        else r["wheelchair_accessible"] == 1
                    ),
                )
            )
        if day == start.date():
            # Fetch windows to the end of the service day so back-to-back windows can be merged.
            freq_args = (stop_id, day, day.isoweekday(), a, max(b, 30 * 3600))
            freq_rows = list(await pool.fetch(_FREQUENCIES_SQL, *freq_args))
    departures.sort(key=lambda d: d.time)

    service_end = {
        r["source"]: r["service_end"]
        for r in await pool.fetch("SELECT source, service_end FROM feed_version WHERE is_active")
    }
    return StopBoard(
        stop=summary,
        generated_at=now,
        window_start=start,
        window_end=end,
        departures=departures[:limit],
        frequencies=_merge_frequencies(freq_rows, freq_day, start, end),
        notices=_notices(sources, service_end, now.date()),
    )
