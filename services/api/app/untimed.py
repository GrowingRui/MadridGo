"""Lines that stop somewhere but have no published timetable (app/ingest/untimed.py).

MadridGo can neither list nor plan them, so boards and journeys at their stops say so.
"""

from collections import defaultdict

import asyncpg

from app.i18n import tr
from app.timetable import line_sort_key

_SQL = """
    SELECT DISTINCT u.root_id, fv.source, coalesce(r.short_name, r.native_id) AS name
    FROM untimed_route_stop u
    JOIN feed_version fv ON fv.id = u.feed_version_id AND fv.is_active
    JOIN route r ON r.feed_version_id = u.feed_version_id AND r.native_id = u.route_id
    WHERE u.root_id = ANY($1::text[])
"""


async def untimed_lines(pool: asyncpg.Pool, root_ids: list[str]) -> dict[str, list[str]]:
    """Stop (root id) -> short names of lines stopping there without a timetable."""
    if not root_ids:
        return {}
    out: dict[str, set[str]] = defaultdict(set)
    for r in await pool.fetch(_SQL, root_ids):
        out[r["root_id"]].add(r["name"])
    return {k: sorted(v, key=line_sort_key) for k, v in out.items()}


def untimed_message(lines: list[str], stop: str | None = None) -> str:
    """The notice for one stop; `stop` names it (journeys), else it is the board's stop."""
    key = "notice.untimed_one" if len(lines) == 1 else "notice.untimed"
    where = tr("notice.untimed_at", stop=stop) if stop else tr("notice.untimed_here")
    return tr(key, lines=", ".join(lines), where=where)
