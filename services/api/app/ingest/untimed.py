"""Lines a feed lists but gives no trips, and where they stop.

CRTM's bus feeds list some lines without a single trip (found 2026-11-16: 12 interurban
lines, mostly Colmenar Viejo 720-728 and N702, and 5 town lines; the archived files back to
November 2025 have the same gap). MadridGo can neither show nor plan such a line, but it
can tell people at its stops. CRTM's network map on its open-data portal (ArcGIS layer
"ParadasPorItinerario" of M8_Red / M9_Red) lists the stops of every current itinerary,
with the same line ids as the feed (IDFLINEA = route_id, e.g. 8__721___) and stop ids
(IDFESTACION 8_11350 = GTFS stop par_8_11350).

Only stops; no times are taken from the map.
"""

import logging
from collections import defaultdict
from collections.abc import Iterable, Mapping
from datetime import date
from typing import Any

import asyncpg
import httpx

from app.ingest.download import USER_AGENT

log = logging.getLogger(__name__)

PAGE = 2000  # the layer's maxRecordCount
FIELDS = "IDFLINEA,IDFESTACION,FECHAINICIO,FECHAFIN"


def stops_by_route(rows: Iterable[Mapping[str, Any]], today: date) -> dict[str, set[str]]:
    """route_id -> native GTFS stop ids, from the layer's rows in force today."""
    day = today.strftime("%Y%m%d")
    out: dict[str, set[str]] = defaultdict(set)
    for a in rows:
        route, station = a.get("IDFLINEA"), a.get("IDFESTACION")
        if not route or not station:
            continue
        start, end = a.get("FECHAINICIO") or "", a.get("FECHAFIN") or ""
        if (start and start > day) or (end and end < day):
            continue
        out[route].add(f"par_{station}")
    return dict(out)


def fetch_layer(url: str, route_ids: list[str], timeout_s: float = 60.0) -> list[dict[str, Any]]:
    """Rows of an ArcGIS stop-per-itinerary layer for these lines (all pages)."""
    quoted = ",".join("'" + r.replace("'", "''") + "'" for r in route_ids)
    where = f"IDFLINEA IN ({quoted})"
    rows: list[dict[str, Any]] = []
    with httpx.Client(timeout=timeout_s, headers={"User-Agent": USER_AGENT}) as http:
        while True:
            resp = http.post(
                f"{url}/query",
                data={
                    "where": where,
                    "outFields": FIELDS,
                    "returnGeometry": "false",
                    "resultOffset": len(rows),
                    "resultRecordCount": PAGE,
                    "f": "json",
                },
            )
            resp.raise_for_status()
            body = resp.json()
            if "error" in body:  # ArcGIS reports errors with HTTP 200
                raise RuntimeError(f"network layer error: {body['error']}")
            features = body.get("features") or []
            rows += [f["attributes"] for f in features]
            if not body.get("exceededTransferLimit") or not features:
                return rows


async def routes_without_trips(conn: asyncpg.Connection, fv: int) -> list[str]:
    rows = await conn.fetch(
        """SELECT r.native_id FROM route r
           WHERE r.feed_version_id = $1
             AND NOT EXISTS (SELECT 1 FROM trip t
                             WHERE t.feed_version_id = $1 AND t.route_id = r.native_id)
           ORDER BY r.native_id""",
        fv,
    )
    return [r["native_id"] for r in rows]


async def store(conn: asyncpg.Connection, fv: int, stops: Mapping[str, set[str]]) -> int:
    """Replace the version's untimed stops; keeps only stops the feed has."""
    pairs = [(route, stop) for route, ids in stops.items() for stop in ids]
    async with conn.transaction():
        await conn.execute("DELETE FROM untimed_route_stop WHERE feed_version_id = $1", fv)
        return int(
            await conn.fetchval(
                """WITH ins AS (
                       INSERT INTO untimed_route_stop
                           (feed_version_id, route_id, stop_native_id, root_id)
                       SELECT $1::integer, q.route_id, q.stop_id, s.root_id
                       FROM unnest($2::text[], $3::text[]) AS q(route_id, stop_id)
                       JOIN stop s ON s.feed_version_id = $1 AND s.native_id = q.stop_id
                       ON CONFLICT DO NOTHING
                       RETURNING 1)
                   SELECT count(*) FROM ins""",
                fv,
                [p[0] for p in pairs],
                [p[1] for p in pairs],
            )
        )


async def record_untimed(
    conn: asyncpg.Connection, fv: int, layer_url: str, today: date
) -> tuple[list[str], int] | None:
    """Find the version's lines without trips and store their stops from the network map.

    Returns (lines, stops stored), or None when the map could not be read (the stops
    stored before, if any, are kept).
    """
    routes = await routes_without_trips(conn, fv)
    if not routes:
        await store(conn, fv, {})
        return [], 0
    try:
        rows = fetch_layer(layer_url, routes)
    except (httpx.HTTPError, RuntimeError, ValueError) as exc:
        log.warning("network map %s unavailable: %s", layer_url, exc)
        return None
    stops = stops_by_route(rows, today)
    return routes, await store(conn, fv, {r: stops.get(r, set()) for r in routes})
