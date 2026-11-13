"""Step-free travel: which trains and stations a wheelchair user can use (GTFS
`wheelchair_accessible` on trips, `wheelchair_boarding` on stops).

Only Renfe's Cercanías data is used. Checked on 2026-11-13: Renfe marks every station
(74 step-free, 21 not) and every trip (about 60% accessible). The CRTM feeds are not usable:
Metro marks 6 of its stations step-free and Metro Ligero none, while every Metro and Metro
Ligero trip is marked accessible; the interurban buses mark no stop step-free; EMT gives
nothing. Showing those would tell people that step-free stations are not, so for them the
answer is "unknown" (None).
"""

import asyncpg
from pydantic import BaseModel

ACCESS_FEEDS = frozenset({"cercanias"})


def accessible(value: int | None) -> bool | None:
    """GTFS 1 -> True, 2 -> False, 0 or empty -> None (no information)."""
    if value == 1:
        return True
    if value == 2:
        return False
    return None


class LegAccess(BaseModel):
    """A ride for a wheelchair user: the train, and the stations where you board and get off.
    None: no information."""

    vehicle: bool | None = None
    board: bool | None = None
    alight: bool | None = None


_TRIPS_SQL = """
    SELECT fv.source, t.native_id, t.wheelchair_accessible
    FROM unnest($1::text[], $2::text[]) AS q(source, trip_id)
    JOIN feed_version fv ON fv.is_active AND fv.source = q.source
    JOIN trip t ON t.feed_version_id = fv.id AND t.native_id = q.trip_id
"""

# A station is step-free when one of its platforms is (GTFS: a platform without a value takes
# its station's, which Renfe's file does not need: it has no parent stations).
_STOPS_SQL = """
    SELECT q.id,
           CASE WHEN bool_or(s.wheelchair_boarding = 1) THEN 1
                WHEN bool_or(s.wheelchair_boarding = 2) THEN 2 END AS wheelchair_boarding
    FROM unnest($1::text[]) AS q(id)
    JOIN stop s ON s.id = q.id OR s.root_id = q.id
    JOIN feed_version fv ON fv.id = s.feed_version_id AND fv.is_active
    WHERE fv.source = ANY($2::text[])
    GROUP BY q.id
"""


async def trip_access(
    pool: asyncpg.Pool, trips: list[tuple[str, str]]
) -> dict[tuple[str, str], bool | None]:
    """(feed, native trip id) -> wheelchair accessible, for the feeds whose data is used."""
    trips = [t for t in trips if t[0] in ACCESS_FEEDS]
    if not trips:
        return {}
    rows = await pool.fetch(_TRIPS_SQL, [t[0] for t in trips], [t[1] for t in trips])
    return {(r["source"], r["native_id"]): accessible(r["wheelchair_accessible"]) for r in rows}


async def stop_access(pool: asyncpg.Pool, stop_ids: list[str]) -> dict[str, bool | None]:
    """Global stop or station id -> step-free, from the feeds whose data is used."""
    if not stop_ids:
        return {}
    rows = await pool.fetch(_STOPS_SQL, sorted(set(stop_ids)), sorted(ACCESS_FEEDS))
    return {r["id"]: accessible(r["wheelchair_boarding"]) for r in rows}
