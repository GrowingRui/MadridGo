"""Every Cercanías train on one map (Phase 6, "Live trains" on Plan > Map), like a
Flightradar for Madrid's suburban trains.

- `GET /trains/lines`: each line's track, to draw under the trains. The tracks are the
  repaired shapes OpenTripPlanner was built with (app/ingest/shapes.py), read from OTP once
  and kept in memory; one line usually has several patterns over the same track, so a pattern
  is only sent when it adds track the line does not have yet.
- `GET /trains/live`: every train in Renfe's feed that has left its first station, placed
  exactly as on the trip screen (app/trips.py `locate`: live where Renfe gives a usable
  position, otherwise estimated from the timetable and the live delay, always labelled), with
  the piece of track between its two stations so the app can move it along the line.

Only Cercanías: Renfe is the only Madrid operator publishing positions for the whole network.
CRTM has no real-time Metro data (reply of 2026-11-16) and EMT gives bus positions per stop,
on request. Renfe's feed lists practically every running train (2026-11-16 21:08: 54 trains
on their way, 51 waiting at their first station, 61 running by the timetable), so a train
missing from the feed is not added from the timetable. When the feed is outdated or missing
no train is shown at all: an old list would draw trains that have since arrived.
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.dbpool import get_pool
from app.i18n import tr
from app.otp import OtpClient, OtpUnavailable, get_otp
from app.realtime import renfe
from app.realtime.board import renfe_freshness
from app.realtime.freshness import is_usable
from app.realtime.models import FeedSnapshot, Freshness
from app.realtime.service import Realtime, get_realtime, now_utc
from app.stops import Line
from app.timetable import display_name
from app.trips import TripPosition, TripStop, distance_m, locate, project

log = logging.getLogger(__name__)

router = APIRouter(tags=["trains"])

FEED = "cercanias"
POLL_AFTER_S = 15
# A station further than this from its pattern's track is not on it (then the app draws a
# straight line between the two stations).
ON_TRACK_M = 300
# A pattern is sent only when this share of its track is new for its line.
NEW_TRACK_SHARE = 0.2
NETWORK_TTL_S = 6 * 3600
NETWORK_RETRY_S = 60

NETWORK_QUERY = """
{ routes(feeds: ["cercanias"]) {
    gtfsId shortName
    patterns { code patternGeometry { points } trips { gtfsId } }
} }
"""

LatLon = tuple[float, float]


class TrainLine(BaseModel):
    line: Line
    # The line's track as Google encoded polylines (precision 5), one per kept pattern.
    paths: list[str]


class TrainLines(BaseModel):
    lines: list[TrainLine]
    # False when OpenTripPlanner could not be read: trains still come, without tracks.
    available: bool


class LiveTrain(TripPosition):
    line: Line | None = None
    headsign: str | None = None
    # The track from last_stop to next_stop, [lon, lat], when both stations are on it.
    path: list[list[float]] | None = None


class LiveTrains(BaseModel):
    trains: list[LiveTrain]
    freshness: Freshness | None = None
    observed_at: datetime | None = None
    message: str | None = None  # why there are no trains, when the data is unusable
    source: str = renfe.SOURCE
    attribution: str = renfe.ATTRIBUTION
    poll_after_s: int = POLL_AFTER_S


# ---------------------------------------------------------------------------
# Tracks (pure)


def decode_polyline(encoded: str) -> list[LatLon]:
    out: list[LatLon] = []
    i = lat = lon = 0
    n = len(encoded)
    while i < n:
        vals = []
        for _ in range(2):
            result = shift = 0
            while True:
                if i >= n:
                    return out  # cut short: keep what was read
                b = ord(encoded[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            vals.append(~(result >> 1) if result & 1 else result >> 1)
        lat += vals[0]
        lon += vals[1]
        out.append((lat / 1e5, lon / 1e5))
    return out


def line_order(short_name: str) -> tuple[int, str]:
    """C1, C2, ..., C4a, C4b, ..., C10 (number first, then the letter)."""
    digits = "".join(c for c in short_name if c.isdigit())
    return (int(digits) if digits else 999, short_name)


@dataclass
class Network:
    # Native trip id -> its pattern's track (lat, lon).
    trip_track: dict[str, list[LatLon]] = field(default_factory=dict)
    # Line short name -> encoded tracks to draw.
    line_paths: dict[str, list[str]] = field(default_factory=dict)


def build_network(data: dict[str, Any]) -> Network:
    """The network from OTP's answer to NETWORK_QUERY."""
    net = Network()
    by_line: dict[str, list[tuple[str, list[LatLon]]]] = {}
    for route in data.get("routes") or []:
        name = route.get("shortName") or ""
        for p in route.get("patterns") or []:
            encoded = (p.get("patternGeometry") or {}).get("points")
            if not encoded:
                continue
            track = decode_polyline(encoded)
            if len(track) < 2:
                continue
            for t in p.get("trips") or []:
                native = (t.get("gtfsId") or "").partition(":")[2]
                if native:
                    net.trip_track[native] = track
            by_line.setdefault(name, []).append((encoded, track))
    for name, patterns in by_line.items():
        covered: set[tuple[LatLon, LatLon]] = set()
        kept: list[str] = []
        for encoded, track in sorted(patterns, key=lambda p: -len(p[1])):
            segs = {
                tuple(sorted(((round(a[0], 4), round(a[1], 4)), (round(b[0], 4), round(b[1], 4)))))
                for a, b in zip(track, track[1:], strict=False)
            }
            if not kept or len(segs - covered) > NEW_TRACK_SHARE * len(segs):
                kept.append(encoded)
            covered |= segs  # type: ignore[arg-type]
        net.line_paths[name] = kept
    return net


def _nearest(
    track: list[LatLon], p: LatLon, after: tuple[int, float] = (0, 0.0)
) -> tuple[int, float, float] | None:
    """(segment index, fraction along it, metres off) of the track's point nearest to p, at
    or after position `after`."""
    best: tuple[int, float, float] | None = None
    for i in range(after[0], len(track) - 1):
        t, off = project(p, track[i], track[i + 1])
        if i == after[0] and t < after[1]:
            t = after[1]
            off = distance_m(p, _lerp(track[i], track[i + 1], t))
        if best is None or off < best[2]:
            best = (i, t, off)
    return best


def _lerp(a: LatLon, b: LatLon, t: float) -> LatLon:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def segment_path(track: list[LatLon], a: LatLon, b: LatLon) -> list[list[float]] | None:
    """The track from station a to station b as [lon, lat] points, starting and ending at the
    stations themselves. None when either station is more than ON_TRACK_M off the track, or
    b does not come after a."""
    if len(track) < 2:
        return None
    pa = _nearest(track, a)
    if pa is None or pa[2] > ON_TRACK_M:
        return None
    pb = _nearest(track, b, (pa[0], pa[1]))
    if pb is None or pb[2] > ON_TRACK_M or (pb[0], pb[1]) <= (pa[0], pa[1]):
        return None
    points = [a]
    for p in [*track[pa[0] + 1 : pb[0] + 1], b]:
        if distance_m(points[-1], p) >= 1:  # a station on a track point: not twice
            points.append(p)
        elif p is b:
            points[-1] = b
    return [[round(lon, 5), round(lat, 5)] for lat, lon in points]


# ---------------------------------------------------------------------------
# All trains (pure: no I/O, the clock is an argument)


@dataclass(frozen=True)
class TrainInfo:
    line: Line
    headsign: str | None


def live_trains(
    snap: FeedSnapshot | None,
    stops: dict[str, list[TripStop]],
    info: dict[str, TrainInfo],
    network: Network | None,
    now: datetime,
) -> LiveTrains:
    """Every train of the snapshot that is on its way. `stops` and `info` are keyed by native
    trip id; trips without a timetable (not in the Madrid feed) are left out."""
    fresh = renfe_freshness(snap, now)
    observed = (snap.source_timestamp or snap.retrieved_at) if snap else None
    out = LiveTrains(trains=[], freshness=fresh, observed_at=observed)
    if snap is None or not is_usable(fresh):
        out.message = tr("trains.no_live")
        return out
    waiting = set(snap.not_departed)
    for native in sorted(set(snap.trips) | set(snap.vehicles)):
        tu = snap.trips.get(native)
        if native in waiting or (tu is not None and tu.cancelled) or native not in stops:
            continue
        pos = locate(f"{FEED}:{native}", stops[native], snap, now)
        if pos.status == "unavailable" or pos.last_stop is None:
            continue
        meta = info.get(native)
        path = None
        track = network.trip_track.get(native) if network else None
        a, b = pos.last_stop, pos.next_stop
        if track and b is not None and None not in (a.lat, a.lon, b.lat, b.lon):
            path = segment_path(track, (a.lat, a.lon), (b.lat, b.lon))  # type: ignore[arg-type]
        out.trains.append(
            LiveTrain(
                **pos.model_dump(),
                line=meta.line if meta else None,
                headsign=(meta.headsign if meta else None) or stops[native][-1].name,
                path=path,
            )
        )
    return out


# ---------------------------------------------------------------------------
# I/O: OTP's tracks (in memory) and the trains' timetables (database)


class NetworkCache:
    def __init__(self) -> None:
        self.network: Network | None = None
        self.loaded_at = 0.0
        self.failed_at = 0.0
        self.lock = asyncio.Lock()

    async def get(self, otp: OtpClient) -> Network | None:
        clock = time.monotonic()
        if self.network and clock - self.loaded_at < NETWORK_TTL_S:
            return self.network
        if clock - self.failed_at < NETWORK_RETRY_S:
            return self.network  # the old one (or none) until the next try
        async with self.lock:
            if self.network and time.monotonic() - self.loaded_at < NETWORK_TTL_S:
                return self.network
            try:
                data = await otp.query(NETWORK_QUERY, timeout_s=30)
                self.network = build_network(data)
                self.loaded_at = time.monotonic()
                log.info("train tracks: %d lines", len(self.network.line_paths))
            except OtpUnavailable as exc:
                self.failed_at = time.monotonic()
                log.warning("train tracks unavailable: %s", exc)
            return self.network


_network = NetworkCache()


def get_network_cache() -> NetworkCache:
    return _network


class TrainTimetable:
    """The timetable and line of many Cercanías trips at once (one query each)."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    async def stops(self, natives: list[str]) -> dict[str, list[TripStop]]:
        rows = await self.pool.fetch(
            """
            SELECT st.trip_id, st.stop_id AS native_id, s.id, s.root_id, s.name, s.lat, s.lon,
                   st.arrival_s, st.departure_s
            FROM feed_version fv
            JOIN stop_time st ON st.feed_version_id = fv.id AND st.trip_id = ANY($1::text[])
            JOIN stop s ON s.feed_version_id = fv.id AND s.native_id = st.stop_id
            WHERE fv.is_active AND fv.source = $2
            ORDER BY st.trip_id, st.stop_sequence
            """,
            natives,
            FEED,
        )
        out: dict[str, list[TripStop]] = {}
        for r in rows:
            trip = out.setdefault(r["trip_id"], [])
            trip.append(
                TripStop(
                    index=len(trip),
                    native_id=r["native_id"],
                    stop_id=r["id"],
                    root_id=r["root_id"],
                    name=display_name(r["name"]),
                    lat=r["lat"],
                    lon=r["lon"],
                    arrival_s=r["arrival_s"],
                    departure_s=r["departure_s"],
                )
            )
        return out

    async def info(self, natives: list[str]) -> dict[str, TrainInfo]:
        rows = await self.pool.fetch(
            """
            SELECT t.native_id, t.headsign, r.native_id AS route_id, r.short_name, r.long_name,
                   r.color, r.text_color
            FROM feed_version fv
            JOIN trip t ON t.feed_version_id = fv.id AND t.native_id = ANY($1::text[])
            JOIN route r ON r.feed_version_id = fv.id AND r.native_id = t.route_id
            WHERE fv.is_active AND fv.source = $2
            """,
            natives,
            FEED,
        )
        return {
            r["native_id"]: TrainInfo(
                line=Line(
                    source=FEED,
                    route_id=f"{FEED}:{r['route_id']}",
                    short_name=r["short_name"] or "",
                    long_name=r["long_name"],
                    mode="rail",
                    color=r["color"],
                    text_color=r["text_color"],
                ),
                headsign=display_name(r["headsign"]) if r["headsign"] else None,
            )
            for r in rows
        }

    async def lines(self) -> dict[str, Line]:
        """Each line by short name (the first route of that name)."""
        rows = await self.pool.fetch(
            """
            SELECT DISTINCT ON (r.short_name) r.native_id, r.short_name, r.long_name, r.color,
                   r.text_color
            FROM feed_version fv JOIN route r ON r.feed_version_id = fv.id
            WHERE fv.is_active AND fv.source = $1 AND r.short_name IS NOT NULL
            ORDER BY r.short_name, r.native_id
            """,
            FEED,
        )
        return {
            r["short_name"]: Line(
                source=FEED,
                route_id=f"{FEED}:{r['native_id']}",
                short_name=r["short_name"],
                long_name=r["long_name"],
                mode="rail",
                color=r["color"],
                text_color=r["text_color"],
            )
            for r in rows
        }


def get_train_timetable(pool: Annotated[asyncpg.Pool, Depends(get_pool)]) -> TrainTimetable:
    return TrainTimetable(pool)


@router.get("/trains/lines", response_model=TrainLines)
async def train_lines(
    timetable: Annotated[TrainTimetable, Depends(get_train_timetable)],
    cache: Annotated[NetworkCache, Depends(get_network_cache)],
    otp: Annotated[OtpClient, Depends(get_otp)],
) -> TrainLines:
    """The Cercanías lines and their tracks, to draw under the live trains."""
    network = await cache.get(otp)
    lines = await timetable.lines()
    paths = network.line_paths if network else {}
    return TrainLines(
        lines=[
            TrainLine(line=lines[name], paths=paths.get(name, []))
            for name in sorted(lines, key=line_order)
        ],
        available=network is not None,
    )


@router.get("/trains/live", response_model=LiveTrains)
async def trains_live(
    rt: Annotated[Realtime, Depends(get_realtime)],
    timetable: Annotated[TrainTimetable, Depends(get_train_timetable)],
    cache: Annotated[NetworkCache, Depends(get_network_cache)],
    otp: Annotated[OtpClient, Depends(get_otp)],
) -> LiveTrains:
    """Every Cercanías train on its way now, from Renfe's live data. Poll every
    `poll_after_s`; between answers the app moves each train as on the trip screen."""
    snap = await rt.renfe_snapshot()
    natives = sorted(set(snap.trips) | set(snap.vehicles)) if snap else []
    if not natives:
        return live_trains(snap, {}, {}, None, now_utc())
    stops = await timetable.stops(natives)
    info = await timetable.info(natives)
    return live_trains(snap, stops, info, await cache.get(otp), now_utc())
