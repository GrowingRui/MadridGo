"""How late is a Cercanías train usually? ("Usually ~4 min late", DB Navigator's punctuality)

Built from the arrivals the accuracy sampler sees (`observed_arrival`, app/realtime/
accuracy.py): actual arrival - timetable, for every Renfe train at every station but its
first. Once a day the worker turns the last WINDOW_DAYS days into figures per line at four
levels, from the most to the least detailed:

1. the station at this time of the week (`stop_time`),
2. the station at any time (`stop`),
3. the whole line at this time of the week (`line_time`),
4. the whole line (`line`).

A figure is kept only with at least MIN_N arrivals on MIN_LEVEL_DAYS different days, and
none at all until the data spans MIN_DAYS days (as the accuracy page's "early figures"), so
a few bad mornings never become "usually late". The app looks a train up at the most
detailed level that has a figure, and shows it only while the train has no live time:
a live delay always wins.

The figure is the median (half the trains were later, half earlier), so one train an hour
late does not move it; `often_s` is the 80th percentile ("often up to"). Early arrivals
count as on time, as the app never shows a train early (`board.shown_delay`).
"""

import logging
import statistics
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Annotated, Literal

import asyncpg
from fastapi import Depends
from pydantic import BaseModel

from app.dbpool import get_pool
from app.realtime import renfe
from app.timetable import MADRID

log = logging.getLogger(__name__)

WINDOW_DAYS = 28
MIN_DAYS = 7  # as accuracy.MIN_DAYS: no figure at all before a week of data
MIN_N = 40
MIN_LEVEL_DAYS = 4
CACHE_TTL_S = 3600

ALL = "*"
Scope = Literal["stop_time", "stop", "line_time", "line"]
# Times of the week. Weekday rush hours differ from the rest; weekends are one band.
Band = Literal["weekday_morning", "weekday_midday", "weekday_evening", "weekday_night", "weekend"]


def band_of(t: datetime) -> Band:
    """The time of the week of a scheduled time (Madrid)."""
    local = t.astimezone(MADRID)
    if local.isoweekday() >= 6:
        return "weekend"
    h = local.hour
    if 6 <= h < 10:
        return "weekday_morning"
    if 10 <= h < 16:
        return "weekday_midday"
    if 16 <= h < 20:
        return "weekday_evening"
    return "weekday_night"


class UsualDelay(BaseModel):
    """How late this train usually is, from past days (not a live value)."""

    minutes: int  # median lateness, rounded; 0 or 1 = on time
    often_minutes: int  # 80% of trains came within this
    sample: int  # arrivals the figure is based on
    days: int  # different days among them
    scope: Scope


@dataclass(frozen=True)
class Observation:
    line: str
    stop_id: str  # native Renfe stop id
    service_date: date
    scheduled_at: datetime
    late_s: float  # actual - scheduled


@dataclass(frozen=True)
class Figure:
    line: str
    stop_id: str  # ALL: the whole line
    band: str  # ALL: any time
    n: int
    days: int
    median_s: float
    often_s: float


def _p80(values: list[float]) -> float:
    if len(values) == 1:
        return values[0]
    return statistics.quantiles(values, n=5, method="inclusive")[3]


def figures(obs: list[Observation]) -> list[Figure]:
    """The figures to keep from the observations of the window (pure)."""
    if len({o.service_date for o in obs}) < MIN_DAYS:
        return []
    groups: dict[tuple[str, str, str], list[Observation]] = defaultdict(list)
    for o in obs:
        band: str = band_of(o.scheduled_at)
        for stop in (o.stop_id, ALL):
            for b in (band, ALL):
                groups[(o.line, stop, b)].append(o)
    out = []
    for (line, stop, band), group in sorted(groups.items()):
        days = len({o.service_date for o in group})
        if len(group) < MIN_N or days < MIN_LEVEL_DAYS:
            continue
        late = [max(o.late_s, 0.0) for o in group]
        out.append(Figure(line, stop, band, len(group), days, statistics.median(late), _p80(late)))
    return out


@dataclass
class UsualDelays:
    """The figures the API serves, keyed by (line, native stop id, band)."""

    by_key: dict[tuple[str, str, str], Figure] = field(default_factory=dict)

    @classmethod
    def of(cls, figs: list[Figure]) -> "UsualDelays":
        return cls({(f.line, f.stop_id, f.band): f for f in figs})

    def lookup(self, line: str | None, stop_id: str | None, at: datetime) -> UsualDelay | None:
        """The most detailed figure for a train of `line` due at `stop_id` at `at`."""
        if not line or not self.by_key:
            return None
        band = band_of(at)
        levels: list[tuple[str, str, Scope]] = [(ALL, band, "line_time"), (ALL, ALL, "line")]
        if stop_id:
            levels = [(stop_id, band, "stop_time"), (stop_id, ALL, "stop"), *levels]
        for stop, b, scope in levels:
            f = self.by_key.get((line, stop, b))
            if f is not None:
                return UsualDelay(
                    minutes=round(f.median_s / 60),
                    often_minutes=round(f.often_s / 60),
                    sample=f.n,
                    days=f.days,
                    scope=scope,
                )
        return None


# --- Database ------------------------------------------------------------------------------


async def refresh(pool: asyncpg.Pool, now: datetime) -> int:
    """Recompute the figures from the last WINDOW_DAYS finished service days (daily, by the
    worker). Returns how many figures were kept."""
    last = (now.astimezone(MADRID) - timedelta(hours=4)).date() - timedelta(days=1)
    first = last - timedelta(days=WINDOW_DAYS - 1)
    rows = await pool.fetch(
        """SELECT line, stop_id, service_date, scheduled_at,
                  extract(epoch FROM observed_at - scheduled_at)::float8 AS late_s
           FROM observed_arrival
           WHERE source = $1 AND line IS NOT NULL AND service_date BETWEEN $2 AND $3""",
        renfe.SOURCE,
        first,
        last,
    )
    figs = figures(
        [
            Observation(r["line"], r["stop_id"], r["service_date"], r["scheduled_at"], r["late_s"])
            for r in rows
        ]
    )
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("DELETE FROM usual_delay WHERE source = $1", renfe.SOURCE)
        await conn.executemany(
            """INSERT INTO usual_delay (source, line, stop_id, band, n, days, median_s,
                   often_s, first_day, last_day)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)""",
            [
                (
                    renfe.SOURCE,
                    f.line,
                    f.stop_id,
                    f.band,
                    f.n,
                    f.days,
                    f.median_s,
                    f.often_s,
                    first,
                    last,
                )
                for f in figs
            ],
        )
    return len(figs)


async def load(pool: asyncpg.Pool) -> UsualDelays:
    rows = await pool.fetch(
        "SELECT line, stop_id, band, n, days, median_s, often_s FROM usual_delay WHERE source = $1",
        renfe.SOURCE,
    )
    return UsualDelays.of(
        [
            Figure(
                r["line"], r["stop_id"], r["band"], r["n"], r["days"], r["median_s"], r["often_s"]
            )
            for r in rows
        ]
    )


_cache: tuple[float, UsualDelays] | None = None


async def get_usual_delays(pool: Annotated[asyncpg.Pool, Depends(get_pool)]) -> UsualDelays:
    """The figures, read from the database at most once an hour. Never fails a request:
    without figures, trains simply show no "usually" line."""
    global _cache
    if _cache is not None and _cache[0] > time.monotonic():
        return _cache[1]
    try:
        delays = await load(pool)
    except (OSError, asyncpg.PostgresError) as exc:
        log.warning("could not load usual delays: %s", type(exc).__name__)
        delays = _cache[1] if _cache else UsualDelays()
    _cache = (time.monotonic() + CACHE_TTL_S, delays)
    return delays
