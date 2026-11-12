"""Start (or end) a journey at an address from a street that leads somewhere.

Found 2026-11-12 (Avenida Leguario 102, Parla): the stop 100 m away was a 905 m walk. OTP
links a point to the single nearest walkable way, and there that way was a mapped sidewalk
whose end at the crossing is not connected to anything in OpenStreetMap, so every walk first
went 300 m the wrong way. Moving the point 20 m onto the avenue gave 111 m.

So for a start or end point (not a stop): ask OTP for the walk to the nearest stop. When it
is much longer than the straight line, try points a few metres around and plan from the one
with the shortest walk (plus the metres moved). The journey still shows the real address:
its first (or last) walk is drawn from it to the point used.
"""

from __future__ import annotations

import asyncio
from math import cos, radians
from typing import Protocol

from app.otp import Walk
from app.trips import distance_m

# The walk to the nearest stop is "stuck" above this many times the straight line, plus this.
STUCK_FACTOR = 2.0
STUCK_EXTRA_M = 150
# Points tried around a stuck one: these distances (m) in 8 directions. Kept short on
# purpose: further out a point can land across a main road or a railway, and a walk that is
# long because of such a barrier is real (seen 2026-11-12: Calle Real 129, Parla, 73 m from a
# stop on the M-408 but 924 m to walk; a point 80 m away "fixed" it by crossing the road).
RADII_M = (10, 20, 30)
# A point tried must make the walk at least this much shorter.
MIN_GAIN_M = 100
# Nearest stop considered (straight line); further away there is nothing to compare with.
NEAR_M = 500

_cache: dict[tuple[float, float, bool], tuple[float, float] | None] = {}
_CACHE_MAX = 2000


class WalkPlanner(Protocol):
    async def walk(
        self, origin: tuple[float, float], destination: tuple[float, float]
    ) -> Walk | None: ...


def around(p: tuple[float, float]) -> list[tuple[tuple[float, float], float]]:
    """Points around p: ((lat, lon), metres from p)."""
    m_lat = 1 / 111_320
    m_lon = 1 / (111_320 * cos(radians(p[0])))
    dirs = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]
    out = []
    for r in RADII_M:
        for dy, dx in dirs:
            k = r / (2**0.5 if dx and dy else 1)
            out.append(((p[0] + dy * k * m_lat, p[1] + dx * k * m_lon), float(r)))
    return out


async def unstick(
    p: tuple[float, float], stop: tuple[float, float] | None, otp: WalkPlanner, *, end: bool
) -> tuple[float, float] | None:
    """A point near p to plan from (end=False) or to (end=True) instead of p, or None when p
    is fine. `stop` is the stop nearest to p."""
    if stop is None:
        return None
    key = (round(p[0], 5), round(p[1], 5), end)
    if key in _cache:
        return _cache[key]

    async def walk(a: tuple[float, float]) -> Walk | None:
        return await (otp.walk(stop, a) if end else otp.walk(a, stop))

    result: tuple[float, float] | None = None
    crow = distance_m(p, stop)
    now = await walk(p)
    if now is not None and now.distance_m > STUCK_FACTOR * crow + STUCK_EXTRA_M:
        points = around(p)
        walks = await asyncio.gather(*(walk(c) for c, _ in points))
        scored = [
            (w.distance_m + moved, c)
            for (c, moved), w in zip(points, walks, strict=True)
            if w is not None
        ]
        if scored:
            best, c = min(scored)
            if best <= now.distance_m - MIN_GAIN_M:
                result = c
    if len(_cache) >= _CACHE_MAX:
        _cache.clear()
    _cache[key] = result
    return result
