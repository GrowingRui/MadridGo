"""Journey planner API (Phase 4): `GET /journeys`.

OTP finds itineraries; this module decides what MadridGo may say about them:

- Times. Every leg keeps its scheduled time. A live estimate is added next to it only from
  MadridGo's own, freshness-checked sources (Renfe GTFS-RT snapshot, EMT arrivals), with
  provenance. OTP's own real-time fields are ignored: OTP does not say how old they are.
- Frequency-based legs (EMT, Metro) are "every ~N min", never a precise time (R13).
- Transfer labels per RELIABILITY_STRATEGY.md §5 (app/transfers.py).
- Expired timetables are excluded from routing, and any itinerary that still uses one is
  dropped (R6).
"""

import asyncio
import hashlib
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Annotated, Any, Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from app.dbpool import get_pool
from app.feeds import ExpiryState, expiry_state
from app.i18n import tr
from app.ingest.sources import SOURCES_BY_KEY
from app.otp import OtpClient, OtpUnavailable, get_otp
from app.realtime import board as live
from app.realtime import emt, renfe
from app.realtime.board import SourceStatus, add_seconds
from app.realtime.emt import LiveFetch
from app.realtime.models import AlertSnapshot, FeedSnapshot, Freshness, RealtimeInfo, ServiceAlert
from app.realtime.service import Realtime, get_realtime
from app.stops import Line, _stop_summary
from app.timetable import MADRID, display_name, mode_for, seconds_into
from app.transfers import TransferLabel, TransferSide, worst
from app.transfers import assess as assess_transfer

router = APIRouter(tags=["journeys"])

SortOption = Literal["earliest_arrival", "fastest", "fewest_transfers", "least_walking"]
TimeStatus = Literal["live", "scheduled", "frequency", "cancelled"]

# Live data is only matched to legs this close to now: Renfe trip IDs repeat on other days,
# and EMT predicts at most ~45 min ahead.
RENFE_WINDOW = (timedelta(hours=-2), timedelta(hours=3))
EMT_WINDOW = (timedelta(minutes=-5), timedelta(minutes=45))
MAX_EMT_STOPS = 6  # EMT calls per request, at most

# OTP preferences per sort option. OTP returns a Pareto set; these shift it towards the
# option, and the results are then sorted by it.
_PREFERENCES: dict[SortOption, dict[str, int | float]] = {
    "fewest_transfers": {"transferCost": 600},
    "least_walking": {"walkReluctance": 5.0},
}


# ---------------------------------------------------------------------------
# Response models


class Place(BaseModel):
    name: str
    stop_id: str | None = None
    lat: float
    lon: float


class LegTime(BaseModel):
    scheduled: datetime  # always the timetable (or OTP's frequency-based estimate)
    estimated: datetime | None = None  # only when status is "live"
    # live: a live estimate exists; scheduled: timetable only; frequency: headway-based
    # service, the time is approximate; cancelled: the operator cancelled the trip.
    status: TimeStatus = "scheduled"
    platform: str | None = None
    realtime: RealtimeInfo | None = None  # provenance of `estimated` or of the cancellation

    @property
    def best(self) -> datetime:
        return self.estimated if self.estimated is not None else self.scheduled


class LegStop(BaseModel):
    name: str
    stop_id: str | None
    time: datetime  # scheduled
    lat: float | None = None
    lon: float | None = None


class Leg(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    mode: str  # walk | rail | metro | light_rail | bus
    line: Line | None = None
    headsign: str | None = None
    trip_id: str | None = None  # global: {feed}:{native}
    from_: str = Field(alias="from")
    to: str
    from_stop_id: str | None = None
    to_stop_id: str | None = None
    departure: LegTime
    arrival: LegTime
    duration_min: int
    distance_m: int | None = None
    headway_min: int | None = None  # frequency-based legs only
    intermediate: list[LegStop] = []
    # For the route map: where the leg starts and ends, and its path as a Google encoded
    # polyline (precision 5, from OTP's legGeometry). None when OTP has no shape.
    from_lat: float | None = None
    from_lon: float | None = None
    to_lat: float | None = None
    to_lon: float | None = None
    geometry: str | None = None


class Transfer(BaseModel):
    """A change between two vehicles."""

    at: str  # where you get off
    stop_id: str | None
    from_leg: int  # index into legs
    to_leg: int
    walk_min: int
    label: TransferLabel | None  # None: onto a frequent service (see wait_up_to_min)
    margin_min: int | None
    wait_up_to_min: int | None
    basis: Literal["live", "scheduled"]
    message: str


class Journey(BaseModel):
    id: str
    departure: LegTime
    arrival: LegTime
    duration_min: int
    transfers: int
    walk_min: int
    legs: list[Leg]
    changes: list[Transfer]
    reliability: TransferLabel | None  # the worst change; None without changes
    feasible: bool
    issues: list[str]
    data_quality: Literal["scheduled", "partly_live"]
    alerts: list[ServiceAlert] = []
    is_preview: Literal[False] = False


class DataNotice(BaseModel):
    source: str
    operator: str
    expiry: ExpiryState
    service_end: date | None
    message: str


class JourneyPlan(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: Place = Field(alias="from")
    to: Place
    generated_at: datetime
    search_time: datetime
    arrive_by: bool
    sort: SortOption
    journeys: list[Journey]
    # Opaque OTP cursors for "Earlier" and "Later" connections.
    earlier_cursor: str | None
    later_cursor: str | None
    notices: list[DataNotice]
    realtime: list[SourceStatus]
    # When nothing (or only walking) is found: OTP's reason, and a sentence for the user.
    routing_error: str | None = None
    message: str | None = None


# ---------------------------------------------------------------------------
# Static data needed around routing (a dependency, so tests can replace it)


@dataclass(frozen=True)
class FeedInfo:
    service_end: dict[str, date | None]  # active feeds
    route_ids: dict[str, list[str]]  # native route ids of expired feeds (for exclusion)


class StaticData:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    async def place(self, stop_id: str) -> Place:
        summary, _ = await _stop_summary(self.pool, stop_id)  # 404 if unknown
        if summary.lat is None or summary.lon is None:
            raise HTTPException(status_code=422, detail=f"Stop {stop_id} has no location")
        return Place(name=summary.name, stop_id=summary.id, lat=summary.lat, lon=summary.lon)

    async def feeds(self, today: date) -> FeedInfo:
        rows = await self.pool.fetch(
            "SELECT id, source, service_end FROM feed_version WHERE is_active"
        )
        ends = {r["source"]: r["service_end"] for r in rows}
        expired = [
            r["id"]
            for r in rows
            if r["source"] in SOURCES_BY_KEY
            and expiry_state(r["service_end"], today, 0)[0] == "expired"
        ]
        routes: dict[str, list[str]] = defaultdict(list)
        if expired:
            for r in await self.pool.fetch(
                "SELECT fv.source, r.native_id FROM route r "
                "JOIN feed_version fv ON fv.id = r.feed_version_id WHERE fv.id = ANY($1::int[])",
                expired,
            ):
                routes[r["source"]].append(r["native_id"])
        return FeedInfo(service_end=ends, route_ids=dict(routes))

    async def frequencies(
        self, trips: list[tuple[str, str]]
    ) -> dict[tuple[str, str], list[tuple[int, int, int]]]:
        """(feed, native trip id) -> [(start_s, end_s, headway_s)] for frequency-based trips."""
        if not trips:
            return {}
        rows = await self.pool.fetch(
            """
            SELECT fv.source, f.trip_id, f.start_s, f.end_s, f.headway_s
            FROM unnest($1::text[], $2::text[]) AS q(source, trip_id)
            JOIN feed_version fv ON fv.is_active AND fv.source = q.source
            JOIN frequency f ON f.feed_version_id = fv.id AND f.trip_id = q.trip_id
            """,
            [t[0] for t in trips],
            [t[1] for t in trips],
        )
        out: dict[tuple[str, str], list[tuple[int, int, int]]] = defaultdict(list)
        for r in rows:
            out[(r["source"], r["trip_id"])].append((r["start_s"], r["end_s"], r["headway_s"]))
        return dict(out)

    async def termini(self, trips: list[tuple[str, str]]) -> dict[tuple[str, str], str]:
        """(feed, native trip id) -> name of the trip's last stop: its direction, for feeds
        such as Renfe's that publish no headsign."""
        if not trips:
            return {}
        rows = await self.pool.fetch(
            """
            SELECT DISTINCT ON (fv.source, st.trip_id) fv.source, st.trip_id, s.name
            FROM unnest($1::text[], $2::text[]) AS q(source, trip_id)
            JOIN feed_version fv ON fv.is_active AND fv.source = q.source
            JOIN stop_time st ON st.feed_version_id = fv.id AND st.trip_id = q.trip_id
            JOIN stop s ON s.feed_version_id = fv.id AND s.native_id = st.stop_id
            ORDER BY fv.source, st.trip_id, st.stop_sequence DESC
            """,
            [t[0] for t in trips],
            [t[1] for t in trips],
        )
        return {(r["source"], r["trip_id"]): r["name"] for r in rows}


def get_clock() -> Callable[[], datetime]:
    return lambda: datetime.now(MADRID)


def get_static(pool: Annotated[asyncpg.Pool, Depends(get_pool)]) -> StaticData:
    return StaticData(pool)


# ---------------------------------------------------------------------------
# OTP -> legs


def _dt(value: str) -> datetime:
    return datetime.fromisoformat(value).astimezone(MADRID)


def split_id(gtfs_id: str) -> tuple[str, str]:
    """'cercanias:1012L27295C4a' -> ('cercanias', '1012L27295C4a')."""
    feed, _, native = gtfs_id.partition(":")
    return feed, native


def global_stop_id(gtfs_id: str) -> str:
    """OTP stop id -> MadridGo stop id ('interurban:par_8_16825' -> 'crtm:par_8_16825')."""
    feed, native = split_id(gtfs_id)
    src = SOURCES_BY_KEY.get(feed)
    return f"{src.id_namespace if src else feed}:{native}"


def headway_for(windows: list[tuple[int, int, int]], service_day: date, at: datetime) -> int:
    """Headway in minutes of the frequency window a leg falls in. Windows are given for the
    trip's first stop, so pick the latest window that started before the leg's time."""
    s = seconds_into(service_day, at)
    started = [w for w in windows if w[0] <= s]
    w = max(started, key=lambda w: w[0]) if started else min(windows, key=lambda w: w[0])
    return max(1, round(w[2] / 60))


@dataclass
class _Draft:
    leg: Leg
    feed: str | None = None
    trip_native: str | None = None
    from_native: str | None = None
    to_native: str | None = None
    service_day: date | None = None
    interlined: bool = False
    # The times OTP planned with (its own real-time estimate, else the timetable). Walks
    # next to this leg are positioned against these.
    otp_start: datetime | None = None
    otp_end: datetime | None = None
    duration_s: int = 0
    passed: bool = False  # Renfe: the train is already beyond the boarding stop


@dataclass
class _Itinerary:
    drafts: list[_Draft]
    feeds: set[str] = field(default_factory=set)


def _otp_time(t: dict[str, Any]) -> datetime:
    est = t.get("estimated") or {}
    return _dt(est["time"] if est.get("time") else t["scheduledTime"])


def _name(place: dict[str, Any], fallback: str) -> str:
    name = place.get("name")
    return display_name(name) if name else fallback


def parse_itinerary(node: dict[str, Any], origin: Place, destination: Place) -> _Itinerary:
    drafts: list[_Draft] = []
    feeds: set[str] = set()
    legs = node["legs"]
    for i, raw in enumerate(legs):
        start = _dt(raw["start"]["scheduledTime"])
        end = _dt(raw["end"]["scheduledTime"])
        from_name = origin.name if i == 0 else _name(raw["from"], "")
        to_name = destination.name if i == len(legs) - 1 else _name(raw["to"], "")
        from_stop = (raw["from"].get("stop") or {}).get("gtfsId")
        to_stop = (raw["to"].get("stop") or {}).get("gtfsId")
        duration_s = round(raw.get("duration") or (end - start).total_seconds())
        common: dict[str, Any] = {
            "from": from_name or _name(raw["from"], "Start"),
            "to": to_name or _name(raw["to"], "Destination"),
            "from_stop_id": global_stop_id(from_stop) if from_stop else None,
            "to_stop_id": global_stop_id(to_stop) if to_stop else None,
            "departure": LegTime(scheduled=start),
            "arrival": LegTime(scheduled=end),
            "duration_min": max(0, round(duration_s / 60)),
            "distance_m": round(raw["distance"]) if raw.get("distance") is not None else None,
            "from_lat": raw["from"].get("lat"),
            "from_lon": raw["from"].get("lon"),
            "to_lat": raw["to"].get("lat"),
            "to_lon": raw["to"].get("lon"),
            "geometry": (raw.get("legGeometry") or {}).get("points"),
        }
        if not raw.get("transitLeg") or raw.get("route") is None:
            drafts.append(_Draft(leg=Leg(mode="walk", **common), duration_s=duration_s))
            continue

        route, trip = raw["route"], raw.get("trip") or {}
        feed, route_native = split_id(route["gtfsId"])
        feeds.add(feed)
        trip_feed, trip_native = split_id(trip["gtfsId"]) if trip.get("gtfsId") else (feed, None)
        line = Line(
            source=feed,
            route_id=route_native,
            short_name=route.get("shortName") or route_native,
            long_name=route.get("longName"),
            mode=mode_for(int(route.get("type") or 3)),
            color=route.get("color"),
            text_color=route.get("textColor"),
        )
        headsign = raw.get("headsign") or trip.get("tripHeadsign")
        intermediate = [
            LegStop(
                name=_name(p, "Stop"),
                stop_id=global_stop_id(p["stop"]["gtfsId"]) if p.get("stop") else None,
                time=_dt((p.get("departure") or p.get("arrival"))["scheduledTime"]),
                lat=p.get("lat"),
                lon=p.get("lon"),
            )
            for p in raw.get("intermediatePlaces") or []
            if (p.get("departure") or p.get("arrival"))
        ]
        leg = Leg(
            mode=line.mode,
            line=line,
            headsign=display_name(headsign) if headsign else None,
            trip_id=f"{trip_feed}:{trip_native}" if trip_native else None,
            intermediate=intermediate,
            **common,
        )
        drafts.append(
            _Draft(
                leg=leg,
                feed=feed,
                trip_native=trip_native,
                from_native=split_id(from_stop)[1] if from_stop else None,
                to_native=split_id(to_stop)[1] if to_stop else None,
                service_day=date.fromisoformat(raw["serviceDate"])
                if raw.get("serviceDate")
                else None,
                interlined=bool(raw.get("interlineWithPreviousLeg")),
                duration_s=duration_s,
                otp_start=_otp_time(raw["start"]),
                otp_end=_otp_time(raw["end"]),
            )
        )
    return _Itinerary(drafts=drafts, feeds=feeds)


def apply_frequencies(
    its: list[_Itinerary], windows: dict[tuple[str, str], list[tuple[int, int, int]]]
) -> None:
    for it in its:
        for d in it.drafts:
            if d.feed is None or d.trip_native is None or d.service_day is None:
                continue
            w = windows.get((d.feed, d.trip_native))
            if not w or d.leg.departure.status == "cancelled":
                continue
            d.leg.headway_min = headway_for(w, d.service_day, d.leg.departure.scheduled)
            d.leg.departure.status = d.leg.arrival.status = "frequency"


def needs_direction(its: list[_Itinerary]) -> list[tuple[str, str]]:
    """Trips of legs that came without a headsign (all Renfe Cercanías trips)."""
    return sorted(
        {
            (d.feed, d.trip_native)
            for it in its
            for d in it.drafts
            if d.feed is not None and d.trip_native is not None and not d.leg.headsign
        }
    )


def apply_termini(its: list[_Itinerary], termini: dict[tuple[str, str], str]) -> None:
    """No headsign: the direction is the trip's last stop, as on station displays. Never
    the passenger's own destination, which would name the wrong train end."""
    for it in its:
        for d in it.drafts:
            if d.leg.headsign or d.feed is None or d.trip_native is None:
                continue
            name = termini.get((d.feed, d.trip_native))
            if name:
                d.leg.headsign = display_name(name)


# ---------------------------------------------------------------------------
# Live overlays


def _near(t: datetime, now: datetime, window: tuple[timedelta, timedelta]) -> bool:
    return now + window[0] <= t <= now + window[1]


def overlay_renfe(
    its: list[_Itinerary], snap: FeedSnapshot | None, fresh: Freshness, now: datetime
) -> None:
    for it in its:
        for d in it.drafts:
            if d.feed != "cercanias" or d.trip_native is None or d.from_native is None:
                continue
            leg = d.leg
            if not _near(leg.departure.scheduled, now, RENFE_WINDOW):
                continue
            dep = live.renfe_train(
                d.trip_native, d.from_native, leg.departure.scheduled, snap, fresh
            )
            if dep.passed:
                d.passed = True
                continue
            if dep.info is not None and dep.info.classification == "CANCELLED":
                for t in (leg.departure, leg.arrival):
                    t.status, t.realtime, t.estimated = "cancelled", dep.info, None
                continue
            if dep.info is not None:
                leg.departure.status = "live"
                leg.departure.estimated = dep.info.predicted_time
                leg.departure.platform = dep.info.platform
                leg.departure.realtime = dep.info
            if d.to_native is not None:
                arr = live.renfe_train(
                    d.trip_native, d.to_native, leg.arrival.scheduled, snap, fresh
                )
                if arr.info is not None and arr.info.classification == "LIVE":
                    leg.arrival.status = "live"
                    leg.arrival.estimated = arr.info.predicted_time
                    leg.arrival.platform = arr.info.platform
                    leg.arrival.realtime = arr.info


def _walk_before(drafts: list[_Draft], i: int) -> tuple[int, int | None]:
    """(walking seconds between the previous vehicle and leg i, index of that vehicle)."""
    walk, j = 0, i - 1
    while j >= 0 and drafts[j].leg.mode == "walk":
        walk += drafts[j].duration_s
        j -= 1
    return walk, (j if j >= 0 else None)


def emt_stops_to_fetch(its: list[_Itinerary], now: datetime) -> list[str]:
    codes: list[str] = []
    for it in its:
        for d in it.drafts:
            if (
                d.feed == "emt"
                and d.from_native
                and d.leg.departure.status != "cancelled"
                and _near(d.leg.departure.scheduled, now, EMT_WINDOW)
                and d.from_native not in codes
            ):
                codes.append(d.from_native)
    return codes[:MAX_EMT_STOPS]


def _legs_pattern(legs: list[Leg]) -> tuple[tuple[str, ...], ...]:
    """What you ride: each vehicle and its stops. A timetabled trip is itself; a frequency
    leg (headway_min set) is only its line, as one line has several template trip ids (EMT)
    and OTP's time on it is not a real departure."""
    return tuple(
        (
            lg.mode,
            lg.line.route_id if lg.line and lg.headway_min is not None else (lg.trip_id or ""),
            lg.from_stop_id or "",
            lg.to_stop_id or "",
        )
        for lg in legs
        if lg.mode != "walk"
    )


def _pattern(it: _Itinerary) -> tuple[tuple[str, ...], ...]:
    return _legs_pattern([d.leg for d in it.drafts])


def _same_ride(a: Leg, b: Leg) -> bool:
    """The same vehicle, for two legs of the same pattern."""
    if a.headway_min is None or b.headway_min is None:
        return a.departure.best == b.departure.best
    va = a.departure.realtime.vehicle_id if a.departure.realtime else None
    vb = b.departure.realtime.vehicle_id if b.departure.realtime else None
    if a.departure.status == "live" and b.departure.status == "live":
        return va == vb and a.departure.best == b.departure.best
    # At least one is only "every ~N min": within one headway it is the same bus.
    gap = abs((a.departure.best - b.departure.best).total_seconds())
    return gap < max(a.headway_min, b.headway_min) * 60


def drop_frequency_copies(journeys: list[Journey]) -> list[Journey]:
    """Drop journeys that ride the same frequency line(s) as another one on the same bus:
    OTP's once-a-minute candidates (see overlay_emt). A journey with live buses is kept over
    a timetable-only copy; otherwise the earlier one in the list. The list order is kept."""

    def live_legs(j: Journey) -> int:
        return sum(lg.departure.status == "live" for lg in j.legs)

    kept: list[Journey] = []
    for j in sorted(journeys, key=live_legs, reverse=True):  # stable: list order within
        if any(lg.headway_min is not None for lg in j.legs) and any(
            _legs_pattern(k.legs) == _legs_pattern(j.legs)
            and all(
                _same_ride(a, b)
                for a, b in zip(
                    [lg for lg in k.legs if lg.mode != "walk"],
                    [lg for lg in j.legs if lg.mode != "walk"],
                    strict=True,
                )
            )
            for k in kept
        ):
            continue
        kept.append(j)
    keep = {id(j) for j in kept}
    return [j for j in journeys if id(j) in keep]


def overlay_emt(
    its: list[_Itinerary], fetched: dict[str, LiveFetch], now: datetime, start: datetime
) -> None:
    """Board each EMT leg on the first live bus of its line that you can still reach.

    EMT runs by headway, so there is no scheduled trip to compare with: delay_s stays null
    and the arrival is the boarding estimate carried forward (marked as such).

    For a frequency line OTP offers the same ride once a minute (15:41, 15:42, ...). Found
    2026-11-12: all of them were put on the same bus, so the list showed one connection five
    times. Itineraries that ride the same way now each take a different bus, in the order of
    OTP's times; one with no bus left keeps OTP's "every ~N min" time (and is then usually
    dropped as a copy, see drop_frequency_copies)."""
    taken: dict[tuple[Any, ...], set[tuple[datetime, str | None]]] = defaultdict(set)
    order = sorted(
        range(len(its)),
        key=lambda k: min((d.leg.departure.scheduled for d in its[k].drafts), default=now),
    )
    for k in order:
        it = its[k]
        pattern = _pattern(it)
        for i, d in enumerate(it.drafts):
            if d.feed != "emt" or d.from_native not in fetched or d.leg.line is None:
                continue
            data = fetched[d.from_native].data
            fresh = live.emt_freshness(data, now)
            walk, prev = _walk_before(it.drafts, i)
            if prev is None:
                # You can set off at the search time; OTP's start is planned backwards from
                # its own estimate of the bus, so it may be later than needed.
                ready = add_seconds(max(start, now), walk)
            else:
                ready = add_seconds(it.drafts[prev].leg.arrival.best, walk)
            line = d.leg.line.short_name.upper()
            used = taken[(pattern, i)]
            # On a frequency line OTP boards you a whole headway after you reach the stop
            # (the longest wait), so the bus it means is due by its time. A later bus belongs
            # to a later candidate, and a candidate already gone takes none: otherwise an
            # "Earlier connections" page was put on the buses of the first page (found
            # 2026-11-12).
            latest = None
            if d.leg.headway_min is not None:
                if d.leg.departure.scheduled < now - timedelta(seconds=60):
                    continue
                latest = d.leg.departure.scheduled + timedelta(
                    minutes=max(5, d.leg.headway_min / 2)
                )
            options = [
                (when, info)
                for a, when, info in live.emt_live(data, fresh, now)
                if a.line.upper() == line
                and when is not None
                and when >= ready - timedelta(seconds=30)
                and (latest is None or when <= latest)
                and (when, info.vehicle_id) not in used
            ]
            if not options:
                continue
            when, info = min(options, key=lambda o: o[0])
            used.add((when, info.vehicle_id))
            leg = d.leg
            shift = round((when - leg.departure.scheduled).total_seconds())
            leg.departure = leg.departure.model_copy(
                update={"status": "live", "estimated": when, "realtime": info}
            )
            arrive = add_seconds(leg.arrival.scheduled, shift)
            leg.arrival = leg.arrival.model_copy(
                update={
                    "status": "live",
                    "estimated": arrive,
                    "realtime": info.model_copy(
                        update={"predicted_time": arrive, "estimated_from_trip_delay": True}
                    ),
                }
            )


# ---------------------------------------------------------------------------
# Journeys


def _boundary(
    walk_time: datetime, ref: LegTime, otp_ref: datetime | None, slack_s: int = 0
) -> LegTime:
    """A time on the walk at the start or end of a journey.

    OTP places that walk against the time it planned the vehicle with (`otp_ref`, which may
    include OTP's own real-time delay). Move it to the timetable, and to MadridGo's live
    estimate when there is one, so it matches what the vehicle leg shows.

    `slack_s` (start walk only): how long OTP had you wait after the walk. A vehicle earlier
    than OTP's time moves the walk back only by what the wait does not cover. Found
    2026-11-12: on a frequency line OTP put the walk at the search time and the bus 13 min
    later; the live bus came 13 min earlier, and the walk was moved to before the search."""
    otp_ref = otp_ref or ref.scheduled

    def shift(to: datetime) -> int:
        d = round((to - otp_ref).total_seconds())
        return d if d >= 0 else min(0, d + slack_s)

    scheduled = add_seconds(walk_time, shift(ref.scheduled))
    if ref.status == "cancelled":
        return LegTime(scheduled=scheduled, status="cancelled", realtime=ref.realtime)
    if ref.status != "live" or ref.estimated is None:
        status: TimeStatus = "frequency" if ref.status == "frequency" else "scheduled"
        return LegTime(scheduled=scheduled, status=status)
    est = add_seconds(walk_time, shift(ref.estimated))
    info = (
        ref.realtime.model_copy(update={"predicted_time": est, "estimated_from_trip_delay": True})
        if ref.realtime
        else None
    )
    return LegTime(scheduled=scheduled, estimated=est, status="live", realtime=info)


def _journey_id(legs: list[Leg]) -> str:
    key = "|".join(
        f"{lg.mode}:{lg.trip_id or ''}:{lg.departure.scheduled.isoformat()}:{lg.from_stop_id}"
        for lg in legs
    )
    return hashlib.sha1(key.encode(), usedforsecurity=False).hexdigest()[:16]


def build_journey(it: _Itinerary) -> Journey:
    drafts = it.drafts
    legs = [d.leg for d in drafts]
    transit = [i for i, d in enumerate(drafts) if d.leg.mode != "walk"]

    changes: list[Transfer] = []
    for i in transit:
        walk, prev = _walk_before(drafts, i)
        if prev is None or drafts[i].interlined:
            continue
        a, b = legs[prev], legs[i]
        res = assess_transfer(
            TransferSide(
                mode=a.mode,
                time=a.arrival.best,
                live=a.arrival.status == "live",
                cancelled=a.arrival.status == "cancelled",
                frequency_headway_min=a.headway_min if a.arrival.status == "frequency" else None,
                stop_id=a.to_stop_id,
            ),
            TransferSide(
                mode=b.mode,
                time=b.departure.best,
                live=b.departure.status == "live",
                cancelled=b.departure.status == "cancelled",
                frequency_headway_min=b.headway_min if b.departure.status == "frequency" else None,
                stop_id=b.from_stop_id,
            ),
            walk,
        )
        changes.append(
            Transfer(
                at=a.to,
                stop_id=a.to_stop_id,
                from_leg=prev,
                to_leg=i,
                walk_min=round(walk / 60),
                label=res.label,
                margin_min=res.margin_s // 60 if res.margin_s is not None else None,
                wait_up_to_min=res.wait_up_to_min,
                basis="live" if a.arrival.status == "live" else "scheduled",
                message=res.message,
            )
        )

    issues: list[str] = []
    for d in drafts:
        lg = d.leg
        name = lg.line.short_name if lg.line else lg.mode
        when = lg.departure.scheduled.strftime("%H:%M")
        if lg.departure.status == "cancelled":
            issues.append(tr("issue.cancelled", line=name, time=when, stop=lg.from_))
        if d.passed:
            issues.append(tr("issue.left", line=name, time=when, stop=lg.from_))
    issues += [
        tr("issue.change", stop=c.at, message=c.message)
        for c in changes
        if c.label == "not_feasible"
    ]

    first, last = legs[0], legs[-1]
    if first.mode == "walk" and transit:
        ref, otp_ref = legs[transit[0]].departure, drafts[transit[0]].otp_start
        # The wait OTP left between the end of the walk and the vehicle.
        slack = max(
            0, round(((otp_ref or ref.scheduled) - first.arrival.scheduled).total_seconds())
        )
        first.departure = _boundary(first.departure.scheduled, ref, otp_ref, slack)
        first.arrival = _boundary(first.arrival.scheduled, ref, otp_ref, slack)
    if last.mode == "walk" and transit:
        ref, otp_ref = legs[transit[-1]].arrival, drafts[transit[-1]].otp_end
        last.departure = _boundary(last.departure.scheduled, ref, otp_ref)
        last.arrival = _boundary(last.arrival.scheduled, ref, otp_ref)
    # Walks between two vehicles start when the vehicle before arrives (found 2026-11-12: a
    # C2 train 15 min late still showed the walk to the next bus at the timetable's time).
    for k in range(1, len(legs) - 1):
        if legs[k].mode == "walk" and legs[k - 1].mode != "walk":
            ref, otp_ref = legs[k - 1].arrival, drafts[k - 1].otp_end
            walk_leg = legs[k]
            walk_leg.departure = _boundary(walk_leg.departure.scheduled, ref, otp_ref)
            walk_leg.arrival = _boundary(walk_leg.arrival.scheduled, ref, otp_ref)
    departure, arrival = first.departure, last.arrival

    times = [t for lg in legs for t in (lg.departure, lg.arrival)]
    # Live times at both ends give the expected duration. With one vehicle, a live departure
    # next to a timetable arrival would make the trip look shorter than it is (its delay is
    # not in the arrival), so both ends are the timetable's. With several vehicles, the last
    # one's time is its own: the times shown give the duration (found 2026-11-12: 16:08 ->
    # 16:36 was "44 min", after a late first train).
    both_live = departure.status == "live" and arrival.status == "live"
    one_vehicle = len(transit) == 1
    start, end = (
        (departure.scheduled, arrival.scheduled)
        if one_vehicle and not both_live
        else (departure.best, arrival.best)
    )
    walk_s = sum(d.duration_s for d in drafts if d.leg.mode == "walk")
    return Journey(
        id=_journey_id(legs),
        departure=departure,
        arrival=arrival,
        duration_min=round((end - start).total_seconds() / 60),
        transfers=len(changes),
        walk_min=round(walk_s / 60),
        legs=legs,
        changes=changes,
        reliability=worst([c.label for c in changes]),
        feasible=not issues,
        issues=issues,
        data_quality="partly_live"
        if any(t.status in ("live", "cancelled") for t in times)
        else "scheduled",
    )


def drop_slow_walks(journeys: list[Journey]) -> list[Journey]:
    """OTP always adds a walk-only option. Keep it only if it is no slower than public
    transport (or if there is nothing else)."""
    transit = [j for j in journeys if any(lg.mode != "walk" for lg in j.legs)]
    if not transit:
        return journeys
    fastest = min(j.duration_min for j in transit)
    return [j for j in journeys if j in transit or j.duration_min <= fastest]


def sort_journeys(journeys: list[Journey], sort: SortOption) -> list[Journey]:
    def key(j: Journey) -> tuple[Any, ...]:
        arr = j.arrival.best
        primary: Any = {
            "earliest_arrival": arr,
            "fastest": j.duration_min,
            "fewest_transfers": j.transfers,
            "least_walking": j.walk_min,
        }[sort]
        return (not j.feasible, primary, arr, j.departure.best)

    return sorted(journeys, key=key)


def journey_alerts(snapshots: list[AlertSnapshot], j: Journey, now: datetime) -> list[ServiceAlert]:
    lines: dict[str, set[str]] = defaultdict(set)
    stops: dict[str, set[str]] = defaultdict(set)
    for lg in j.legs:
        if lg.line is None:
            continue
        lines[lg.line.source].add(lg.line.short_name)
        for sid in (lg.from_stop_id, lg.to_stop_id):
            if sid and sid.startswith("renfe:"):
                stops["cercanias"].add(sid.split(":", 1)[1])
        if lg.line.source == "emt" and lg.from_stop_id:
            stops["emt"].add(lg.from_stop_id.split(":", 1)[1])
    return live.alerts_for_stop(snapshots, dict(lines), dict(stops), now)


# ---------------------------------------------------------------------------
# Notices and messages

# OTP routing error codes with a message of their own (app/i18n.py "routing.<code>").
ROUTING_CODES = {
    "NO_TRANSIT_CONNECTION",
    "NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW",
    "OUTSIDE_SERVICE_PERIOD",
    "OUTSIDE_BOUNDS",
    "LOCATION_NOT_FOUND",
    "NO_STOPS_IN_RANGE",
    "WALKING_BETTER_THAN_TRANSIT",
}


def routing_message(code: str) -> str:
    return tr(f"routing.{code}" if code in ROUTING_CODES else "routing.default")


def plan_notices(info: FeedInfo, used: set[str], today: date) -> list[DataNotice]:
    out = []
    for key, end in sorted(info.service_end.items()):
        src = SOURCES_BY_KEY.get(key)
        if src is None:
            continue
        state, days = expiry_state(end, today, src.expiry_warning_days)
        if state == "expired":
            msg = tr("notice.expired_journeys", operator=src.operator_name, end=end)
        elif state == "expiring" and key in used:
            msg = tr("notice.expiring", operator=src.operator_name, days=days)
        else:
            continue
        out.append(
            DataNotice(
                source=key, operator=src.operator_name, expiry=state, service_end=end, message=msg
            )
        )
    return out


def _operator(feed: str) -> str:
    src = SOURCES_BY_KEY.get(feed)
    return src.operator_name if src else feed


# ---------------------------------------------------------------------------
# Endpoint


def _coords(lat: float | None, lon: float | None, name: str) -> Place | None:
    if lat is None or lon is None:
        return None
    return Place(name=name, lat=lat, lon=lon)


Lat = Annotated[float | None, Query(ge=39.8, le=41.2)]
Lon = Annotated[float | None, Query(ge=-4.6, le=-3.0)]


@router.get("/journeys", response_model=JourneyPlan)
async def journeys(
    static: Annotated[StaticData, Depends(get_static)],
    otp: Annotated[OtpClient, Depends(get_otp)],
    rt: Annotated[Realtime, Depends(get_realtime)],
    clock: Annotated[Callable[[], datetime], Depends(get_clock)],
    from_: Annotated[str | None, Query(alias="from", description="Start stop id")] = None,
    to: Annotated[str | None, Query(description="Destination stop id")] = None,
    from_lat: Lat = None,
    from_lon: Lon = None,
    to_lat: Lat = None,
    to_lon: Lon = None,
    from_name: Annotated[
        str | None, Query(max_length=120, description="Name of the start point (an address)")
    ] = None,
    to_name: Annotated[
        str | None, Query(max_length=120, description="Name of the destination point")
    ] = None,
    at: Annotated[datetime | None, Query(description="Departure time; default now")] = None,
    arrive_by: Annotated[bool, Query(description="`at` is the latest arrival")] = False,
    sort: SortOption = "earliest_arrival",
    cursor: Annotated[
        str | None, Query(max_length=2000, description="earlier_cursor or later_cursor")
    ] = None,
    limit: Annotated[int, Query(ge=1, le=10)] = 5,
) -> JourneyPlan:
    """Journeys between two stops or points, with live times where MadridGo has an
    authorized source and a reliability label for each change."""
    origin = (
        await static.place(from_)
        if from_
        else _coords(from_lat, from_lon, (from_name or "").strip() or tr("place.here"))
    )
    destination = (
        await static.place(to)
        if to
        else _coords(to_lat, to_lon, (to_name or "").strip() or tr("place.here"))
    )
    if origin is None or destination is None:
        raise HTTPException(
            status_code=422, detail="Give from/to stop ids, or from_lat/from_lon and to_lat/to_lon"
        )

    now = clock()
    when = (at.astimezone(MADRID) if at.tzinfo else at.replace(tzinfo=MADRID)) if at else now
    info = await static.feeds(now.date())
    excluded = [f"{feed}:{r}" for feed, routes in info.route_ids.items() for r in routes]

    def loc(p: Place) -> dict[str, Any]:
        return {
            "label": p.name,
            "location": {"coordinate": {"latitude": p.lat, "longitude": p.lon}},
        }

    variables: dict[str, Any] = {
        "origin": loc(origin),
        "destination": loc(destination),
        "first": limit,
        "exclude": excluded,
        **_PREFERENCES.get(sort, {}),
    }
    if cursor:
        # OTP cursors carry the search time and window; "b:" pages back, "a:" forward.
        direction, _, token = cursor.partition(":")
        if direction not in ("a", "b") or not token:
            raise HTTPException(status_code=422, detail="Invalid cursor")
        variables["after" if direction == "a" else "before"] = token
    else:
        key = "latestArrival" if arrive_by else "earliestDeparture"
        variables["dateTime"] = {key: when.isoformat()}
    try:
        data = await otp.plan(variables)
    except OtpUnavailable as exc:
        raise HTTPException(
            status_code=503, detail="Journey planning is unavailable right now. Try again soon."
        ) from exc

    its = [parse_itinerary(e["node"], origin, destination) for e in data.get("edges") or []]
    # R6: never return an itinerary on an expired timetable, even if OTP found one.
    its = [it for it in its if not (it.feeds & set(info.route_ids))]
    trips = sorted(
        {
            (d.feed, d.trip_native)
            for it in its
            for d in it.drafts
            if d.feed is not None and d.trip_native is not None
        }
    )
    apply_frequencies(its, await static.frequencies(trips))
    apply_termini(its, await static.termini(needs_direction(its)))

    used = set().union(*(it.feeds for it in its)) if its else set()
    statuses: list[SourceStatus] = []
    snap = await rt.renfe_snapshot() if "cercanias" in used else None
    if "cercanias" in used:
        fresh = live.renfe_freshness(snap, now)
        overlay_renfe(its, snap, fresh, now)
        statuses.append(
            live.live_status(
                "cercanias",
                _operator("cercanias"),
                renfe.SOURCE,
                renfe.ATTRIBUTION,
                fresh,
                snap.retrieved_at if snap else None,
                snap.source_timestamp if snap else None,
            )
        )
    if "emt" in used:
        codes = emt_stops_to_fetch(its, now)
        results = await asyncio.gather(*(rt.emt_arrivals(c) for c in codes))
        fetched = dict(zip(codes, results, strict=True))
        # An Earlier/Later page starts at its own search time, not now: otherwise a later
        # page's buses were moved back onto the first page's (found 2026-11-12).
        start = (
            _dt(data["searchDateTime"])
            if cursor and not arrive_by and data.get("searchDateTime")
            else when
        )
        overlay_emt(its, fetched, now, start)
        statuses.append(_emt_status(list(results), now))
    for feed in sorted(used - {"cercanias", "emt"}):
        statuses.append(live.no_realtime_status(feed, _operator(feed)))

    built: dict[str, Journey] = {}
    for it in its:
        j = build_journey(it)
        built.setdefault(j.id, j)  # OTP can return the same itinerary twice
    result = drop_frequency_copies(sort_journeys(drop_slow_walks(list(built.values())), sort))
    alert_snaps = await rt.alert_snapshots()
    if alert_snaps:
        result = [
            j.model_copy(update={"alerts": journey_alerts(alert_snaps, j, now)}) for j in result
        ]

    errors = [e.get("code") for e in data.get("routingErrors") or []]
    code = errors[0] if errors else None
    page = data.get("pageInfo") or {}
    return JourneyPlan(
        **{"from": origin},
        to=destination,
        generated_at=now,
        search_time=_dt(data["searchDateTime"]) if data.get("searchDateTime") else when,
        arrive_by=arrive_by,
        sort=sort,
        journeys=result,
        earlier_cursor=f"b:{page['startCursor']}" if page.get("hasPreviousPage") else None,
        later_cursor=f"a:{page['endCursor']}" if page.get("hasNextPage") else None,
        notices=plan_notices(info, used, now.date()),
        realtime=statuses,
        routing_error=code,
        message=routing_message(code) if code else None,
    )


def _emt_status(results: list[LiveFetch], now: datetime) -> SourceStatus:
    if not results:
        return SourceStatus(
            feed="emt",
            operator=_operator("emt"),
            source=emt.SOURCE,
            status="not_available",
            message=tr("rt.emt_window"),
            attribution=emt.ATTRIBUTION,
        )
    # The oldest answer speaks for all EMT legs, so the status never looks better than the
    # worst leg. Any failed stop makes it unavailable.
    failed = [r for r in results if r.data is None]
    data = (
        None if failed else min((r.data for r in results if r.data), key=lambda d: d.retrieved_at)
    )
    return live.live_status(
        "emt",
        _operator("emt"),
        emt.SOURCE,
        emt.ATTRIBUTION,
        live.emt_freshness(data, now),
        data.retrieved_at if data else None,
        None,
        error=failed[0].error if failed else None,
    )
