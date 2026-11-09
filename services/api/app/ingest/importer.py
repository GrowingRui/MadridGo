"""Import a GTFS zip into PostGIS as a new feed version, then activate it atomically."""

import json
import logging
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

import asyncpg

from app.ingest.gtfs import GtfsZip, color, fold, opt_int, parse_date, parse_time
from app.ingest.sources import GtfsSource

log = logging.getLogger(__name__)

# Keep this many versions per source (the active one plus the previous for rollback).
KEEP_VERSIONS = 2


@dataclass(frozen=True)
class ImportResult:
    feed_version_id: int
    row_counts: dict[str, int]
    service_start: date | None
    service_end: date | None


class _Counter:
    """Wraps a row iterator and counts rows, so COPY can stream without materialising."""

    def __init__(self, rows: Iterable[tuple[Any, ...]]) -> None:
        self._rows = rows
        self.n = 0

    def __iter__(self) -> Iterator[tuple[Any, ...]]:
        for row in self._rows:
            self.n += 1
            yield row


def _gid(source: GtfsSource, native: str) -> str:
    return f"{source.id_namespace}:{native}"


def _stops(feed: GtfsZip, fv: int, source: GtfsSource) -> Iterator[tuple[Any, ...]]:
    for r in feed.rows("stops"):
        lat, lon = r.get("stop_lat", ""), r.get("stop_lon", "")
        parent = r.get("parent_station") or None
        gid = _gid(source, r["stop_id"])
        name = r.get("stop_name") or r["stop_id"]
        yield (
            fv,
            r["stop_id"],
            gid,
            _gid(source, parent) if parent else gid,
            r.get("stop_code") or None,
            name,
            fold(name),
            r.get("stop_desc") or None,
            float(lat) if lat else None,
            float(lon) if lon else None,
            opt_int(r.get("location_type", "")) or 0,
            _gid(source, parent) if parent else None,
            r.get("zone_id") or None,
            opt_int(r.get("wheelchair_boarding", "")),
        )


def _routes(feed: GtfsZip, fv: int) -> Iterator[tuple[Any, ...]]:
    for r in feed.rows("routes"):
        yield (
            fv,
            r["route_id"],
            r.get("agency_id") or None,
            r.get("route_short_name") or None,
            " ".join((r.get("route_long_name") or "").split()) or None,
            int(r["route_type"]),
            color(r.get("route_color", "")),
            color(r.get("route_text_color", "")),
        )


def _trips(feed: GtfsZip, fv: int) -> Iterator[tuple[Any, ...]]:
    for r in feed.rows("trips"):
        yield (
            fv,
            r["trip_id"],
            r["route_id"],
            r["service_id"],
            r.get("trip_headsign") or None,
            r.get("trip_short_name") or None,
            opt_int(r.get("direction_id", "")),
            r.get("shape_id") or None,
            opt_int(r.get("wheelchair_accessible", "")),
        )


def _stop_times(feed: GtfsZip, fv: int) -> Iterator[tuple[Any, ...]]:
    for r in feed.rows("stop_times"):
        yield (
            fv,
            r["trip_id"],
            int(r["stop_sequence"]),
            r["stop_id"],
            parse_time(r.get("arrival_time", "")),
            parse_time(r.get("departure_time", "")),
            opt_int(r.get("pickup_type", "")),
            opt_int(r.get("drop_off_type", "")),
        )


def _frequencies(feed: GtfsZip, fv: int) -> Iterator[tuple[Any, ...]]:
    for r in feed.rows("frequencies"):
        yield (
            fv,
            r["trip_id"],
            parse_time(r["start_time"]),
            parse_time(r["end_time"]),
            int(r["headway_secs"]),
            r.get("exact_times") == "1",
        )


_DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def _calendar(feed: GtfsZip, fv: int) -> Iterator[tuple[Any, ...]]:
    for r in feed.rows("calendar"):
        yield (
            fv,
            r["service_id"],
            [r[d] == "1" for d in _DAYS],
            parse_date(r["start_date"]),
            parse_date(r["end_date"]),
        )


def _calendar_dates(feed: GtfsZip, fv: int) -> Iterator[tuple[Any, ...]]:
    seen: set[tuple[str, str]] = set()
    for r in feed.rows("calendar_dates"):
        key = (r["service_id"], r["date"])
        if key in seen:  # some feeds repeat rows; the primary key would reject them
            continue
        seen.add(key)
        yield (fv, r["service_id"], parse_date(r["date"]), int(r["exception_type"]))


def _feed_label(feed: GtfsZip) -> str | None:
    # CRTM's merged feeds repeat feed_info rows; the highest version is the newest.
    labels = [r.get("feed_version", "") for r in feed.rows("feed_info")]
    return max((x for x in labels if x), default=None)


async def _copy(
    conn: asyncpg.Connection, table: str, columns: list[str], rows: Iterable[tuple[Any, ...]]
) -> int:
    counted = _Counter(rows)
    await conn.copy_records_to_table(table, records=counted, columns=columns)
    return counted.n


async def ensure_operator(conn: asyncpg.Connection, source: GtfsSource) -> None:
    await conn.execute(
        """
        INSERT INTO operator (id, name, mode, attribution_text, licence_url)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, mode = EXCLUDED.mode,
            attribution_text = EXCLUDED.attribution_text, licence_url = EXCLUDED.licence_url
        """,
        source.key,
        source.operator_name,
        source.mode,
        source.attribution,
        source.licence_url,
    )


async def import_feed(
    conn: asyncpg.Connection,
    source: GtfsSource,
    zip_path: Path,
    sha256: str,
    downloaded_at: datetime,
    *,
    activate: bool = True,
) -> ImportResult:
    """Load zip_path as a new, inactive feed version; optionally activate it.

    On any error the partial version is removed, and the previously active version
    stays active.
    """
    await ensure_operator(conn, source)
    fv: int = await conn.fetchval(
        """INSERT INTO feed_version (source, downloaded_at, sha256, file_path)
           VALUES ($1, $2, $3, $4) RETURNING id""",
        source.key,
        downloaded_at,
        sha256,
        str(zip_path),
    )
    partition = f"stop_time_fv{fv}"
    try:
        counts: dict[str, int] = {}
        with GtfsZip(zip_path) as feed:
            async with conn.transaction():
                await conn.execute(
                    f"CREATE TABLE {partition} PARTITION OF stop_time FOR VALUES IN ({fv})"
                )
                counts["stops"] = await _copy(
                    conn,
                    "stop",
                    [
                        "feed_version_id",
                        "native_id",
                        "id",
                        "root_id",
                        "code",
                        "name",
                        "search_name",
                        "description",
                        "lat",
                        "lon",
                        "location_type",
                        "parent_id",
                        "zone_id",
                        "wheelchair_boarding",
                    ],
                    _stops(feed, fv, source),
                )
                counts["routes"] = await _copy(
                    conn,
                    "route",
                    [
                        "feed_version_id",
                        "native_id",
                        "agency_id",
                        "short_name",
                        "long_name",
                        "route_type",
                        "color",
                        "text_color",
                    ],
                    _routes(feed, fv),
                )
                counts["trips"] = await _copy(
                    conn,
                    "trip",
                    [
                        "feed_version_id",
                        "native_id",
                        "route_id",
                        "service_id",
                        "headsign",
                        "short_name",
                        "direction_id",
                        "shape_id",
                        "wheelchair_accessible",
                    ],
                    _trips(feed, fv),
                )
                counts["stop_times"] = await _copy(
                    conn,
                    partition,
                    [
                        "feed_version_id",
                        "trip_id",
                        "stop_sequence",
                        "stop_id",
                        "arrival_s",
                        "departure_s",
                        "pickup_type",
                        "drop_off_type",
                    ],
                    _stop_times(feed, fv),
                )
                counts["frequencies"] = await _copy(
                    conn,
                    "frequency",
                    ["feed_version_id", "trip_id", "start_s", "end_s", "headway_s", "exact_times"],
                    _frequencies(feed, fv),
                )
                counts["calendar"] = await _copy(
                    conn,
                    "service_calendar",
                    ["feed_version_id", "service_id", "days", "start_date", "end_date"],
                    _calendar(feed, fv),
                )
                counts["calendar_dates"] = await _copy(
                    conn,
                    "service_calendar_date",
                    ["feed_version_id", "service_id", "date", "exception_type"],
                    _calendar_dates(feed, fv),
                )
                label = _feed_label(feed)

                await conn.execute(
                    f"""
                    ALTER TABLE {partition} ADD PRIMARY KEY (trip_id, stop_sequence);
                    CREATE INDEX {partition}_stop_idx ON {partition} (stop_id, departure_s);
                    """
                )
                await _derive(conn, fv, partition)
                start, end = await _service_range(conn, fv)
                await conn.execute(
                    """UPDATE feed_version SET imported_at = now(), feed_version_label = $2,
                           service_start = $3, service_end = $4, row_counts = $5::jsonb
                       WHERE id = $1""",
                    fv,
                    label,
                    start,
                    end,
                    json.dumps(counts),
                )
    except BaseException:
        await delete_version(conn, fv)
        raise
    await conn.execute(f"ANALYZE {partition}")
    if activate:
        await activate_version(conn, source.key, fv)
    return ImportResult(fv, counts, start, end)


async def _derive(conn: asyncpg.Connection, fv: int, partition: str) -> None:
    """Fill derived columns and tables that the API reads."""
    # Fresh rows have no planner statistics yet; without them these joins pick
    # nested loops and take minutes instead of seconds.
    await conn.execute(f"ANALYZE {partition}; ANALYZE trip; ANALYZE frequency; ANALYZE stop")
    # CRTM convention: platform par_4_263 belongs to station est_4_263, but many feeds leave
    # parent_station empty. Link them so a station search returns one result with all lines.
    await conn.execute(
        """
        UPDATE stop p SET parent_id = e.id, root_id = e.id
        FROM stop e
        WHERE p.feed_version_id = $1 AND e.feed_version_id = $1
          AND starts_with(p.id, 'crtm:par_') AND p.parent_id IS NULL AND p.location_type = 0
          AND e.native_id = 'est_' || substr(p.native_id, 5) AND e.location_type = 1
        """,
        fv,
    )
    await conn.execute(
        f"""
        UPDATE trip t SET last_stop_sequence = m.seq
        FROM (SELECT trip_id, max(stop_sequence) AS seq FROM {partition} GROUP BY trip_id) m
        WHERE t.feed_version_id = $1 AND t.native_id = m.trip_id
        """,
        fv,
    )
    await conn.execute(
        """
        UPDATE trip t SET is_frequency_based = true
        FROM (SELECT DISTINCT trip_id FROM frequency WHERE feed_version_id = $1) f
        WHERE t.feed_version_id = $1 AND t.native_id = f.trip_id
        """,
        fv,
    )
    await conn.execute(
        f"""
        INSERT INTO stop_route (feed_version_id, stop_native_id, root_id, route_id)
        SELECT $1::integer, p.stop_id, s.root_id, p.route_id
        FROM (SELECT DISTINCT st.stop_id, t.route_id
              FROM {partition} st
              JOIN trip t ON t.feed_version_id = $1 AND t.native_id = st.trip_id) p
        JOIN stop s ON s.feed_version_id = $1 AND s.native_id = p.stop_id
        """,
        fv,
    )


async def _service_range(conn: asyncpg.Connection, fv: int) -> tuple[date | None, date | None]:
    row = await conn.fetchrow(
        """
        SELECT least(c.s, d.s) AS start, greatest(c.e, d.e) AS end FROM
          (SELECT min(start_date) s, max(end_date) e FROM service_calendar
            WHERE feed_version_id = $1) c,
          (SELECT min(date) s, max(date) e FROM service_calendar_date
            WHERE feed_version_id = $1 AND exception_type = 1) d
        """,
        fv,
    )
    return (row["start"], row["end"]) if row else (None, None)


async def activate_version(conn: asyncpg.Connection, source: str, fv: int) -> None:
    """Switch the active version of a source in one transaction, then prune old versions."""
    async with conn.transaction():
        await conn.execute(
            "UPDATE feed_version SET is_active = false WHERE source = $1 AND is_active", source
        )
        await conn.execute("UPDATE feed_version SET is_active = true WHERE id = $1", fv)
    old = await conn.fetch(
        """SELECT id FROM feed_version WHERE source = $1 AND imported_at IS NOT NULL
           ORDER BY id DESC OFFSET $2""",
        source,
        KEEP_VERSIONS,
    )
    for r in old:
        await delete_version(conn, r["id"])


async def delete_version(conn: asyncpg.Connection, fv: int) -> None:
    await conn.execute(f"DROP TABLE IF EXISTS stop_time_fv{int(fv)}")
    await conn.execute("DELETE FROM feed_version WHERE id = $1 AND NOT is_active", fv)
