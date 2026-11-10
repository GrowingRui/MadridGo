"""Where a train is now: `GET /trips/{trip_id}/position` (Phase 5, live position in the
journey timeline).

Read from the cached Renfe snapshot only; the app polls this every ~30 s while a journey is
open, without re-running the route search.

What Renfe's vehicle feed means (checked against GPS and the timetable on the recording of
2026-11-09, tests/fixtures/realtime/):
- `stop_id` is the station the train is at or has just left, whatever `current_status`
  says. STOPPED_AT trains are within ~60 m of it; many INCOMING_AT/IN_TRANSIT_TO trains
  are also standing there, and the moving ones are between it and the following stop.
- The trip update names the following stop (always one further than the vehicle).
- A vehicle carries no observation time of its own (it equals the feed header), so the
  position is as old as the feed.

Live check of 2026-11-10 (3 min of polls at 20 s): most positions are the station's own
coordinates, kept until the train reaches the next station; a departed train can still say
IN_TRANSIT_TO from its old station's coordinates; positions sometimes step back one
station; and around midday most vehicles in the feed are trains waiting at their origin.

So the train is placed between `stop_id` and the next stop of the trip. A train near a
station is at it if it says STOPPED_AT or is not yet due to leave (by Renfe's prediction
for the next stop); otherwise it is on its way, placed by GPS if the fix is off the station,
else by time.

When Renfe gives no usable position (no vehicle for the trip, or the feed is STALE or
missing), the train is placed from the timetable instead, shifted by Renfe's current delay
when a fresh trip update has one: `kind: "estimated"`, which the app draws hollow and
labels. An old live position is never shown.
"""

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from math import cos, hypot, radians
from typing import Annotated, Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel

from app.dbpool import get_pool
from app.i18n import tr
from app.realtime import renfe
from app.realtime.board import add_seconds, renfe_freshness
from app.realtime.freshness import is_usable
from app.realtime.models import FeedSnapshot, Freshness
from app.realtime.service import Realtime, get_realtime, now_utc
from app.timetable import MADRID, at_service_time, display_name

router = APIRouter(tags=["trips"])

# A train this close to a station (GPS, metres) stands at it. Cercanías platforms are
# ~200 m long and STOPPED_AT trains were up to 61 m from the station point.
AT_STOP_M = 150
# A fix further than this from the straight line between the two stations does not belong
# to that segment (lines curve, so a few hundred metres off the chord is normal).
MAX_OFF_LINE_M = 3000
POLL_AFTER_S = 30
# Estimates change at every station, so they are refreshed more often.
ESTIMATE_POLL_AFTER_S = 15

# Static feeds without vehicle positions, and why.
NO_POSITIONS = {
    "metro": "pos.none.metro",
    "ml": "pos.none.ml",
    "emt": "pos.none.bus",
    "interurban": "pos.none.bus",
    "urban": "pos.none.bus",
}

PositionStatus = Literal["at_stop", "between", "unavailable"]
Reason = Literal["not_supported", "cancelled", "not_started", "not_running"]
# live: from Renfe's vehicle position. estimated: where the timetable puts the train,
# shifted by Renfe's current delay when known, because Renfe gives no position for it (or
# its data is outdated). The app always labels estimates as such.
PositionKind = Literal["live", "estimated"]


class PositionStop(BaseModel):
    index: int  # position in the trip's stop sequence, from 0
    stop_id: str  # global, e.g. 'renfe:18000'
    name: str


class TripPosition(BaseModel):
    trip_id: str
    status: PositionStatus
    kind: PositionKind | None = None  # None when unavailable
    reason: Reason | None = None  # why there is no position
    message: str
    # The station the train is at (at_stop) or has just left (between).
    last_stop: PositionStop | None = None
    next_stop: PositionStop | None = None
    # 0..1 along the way from last_stop to next_stop; 0 when at_stop. None: unknown.
    progress: float | None = None
    progress_basis: Literal["gps", "timetable"] | None = None
    # Scheduled seconds from leaving last_stop to arriving at next_stop: the app moves the
    # point at this pace between updates (and never past next_stop without new data).
    segment_run_s: int | None = None
    expected_at_next: datetime | None = None  # predicted (or estimated) arrival at next_stop
    left_at: datetime | None = None  # between: when it left last_stop (predicted)
    departs_at: datetime | None = None  # estimated at_stop: when it is due to leave
    delay_s: int | None = None
    # With ?from_stop=: stations from the train's last_stop to yours. 0: the train is at
    # (or has just left) your stop; negative: it has passed it. None: not on this trip.
    board_index: int | None = None
    stops_away: int | None = None
    observed_at: datetime | None = None
    freshness: Freshness | None = None
    source: str | None = None
    attribution: str | None = None
    poll_after_s: int = POLL_AFTER_S


@dataclass(frozen=True)
class TripStop:
    index: int
    native_id: str
    stop_id: str  # global
    root_id: str
    name: str
    lat: float | None
    lon: float | None
    arrival_s: int | None
    departure_s: int | None

    def ref(self) -> PositionStop:
        return PositionStop(index=self.index, stop_id=self.stop_id, name=self.name)


# ---------------------------------------------------------------------------
# Geometry (local flat projection: fine over a few km)

_M_PER_DEG = 111_320.0


def _xy(lat: float, lon: float, lat0: float) -> tuple[float, float]:
    return lon * _M_PER_DEG * cos(radians(lat0)), lat * _M_PER_DEG


def _pt(lat: float | None, lon: float | None) -> tuple[float, float] | None:
    return (lat, lon) if lat is not None and lon is not None else None


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    ax, ay = _xy(a[0], a[1], a[0])
    bx, by = _xy(b[0], b[1], a[0])
    return hypot(bx - ax, by - ay)


def project(
    p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]
) -> tuple[float, float]:
    """(fraction 0..1 of the way from a to b, distance in metres from the line a-b)."""
    px, py = _xy(p[0], p[1], p[0])
    ax, ay = _xy(a[0], a[1], p[0])
    bx, by = _xy(b[0], b[1], p[0])
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length2))
    return t, hypot(ax + t * dx - px, ay + t * dy - py)


# ---------------------------------------------------------------------------
# Locating the train (pure: no I/O, the clock is an argument)


def _board_index(stops: list[TripStop], from_stop: str | None) -> int | None:
    if not from_stop:
        return None
    for s in stops:
        if from_stop in (s.stop_id, s.root_id):
            return s.index
    return None


def not_supported(trip_id: str, feed: str) -> TripPosition:
    return TripPosition(
        trip_id=trip_id,
        status="unavailable",
        reason="not_supported",
        message=tr(NO_POSITIONS.get(feed, "pos.none.default")),
    )


@dataclass(frozen=True)
class Estimate:
    state: Literal["not_started", "at_stop", "between", "finished"]
    last: TripStop  # first stop (not_started), the stop it is at, or the one it left
    nxt: TripStop | None
    left_at: datetime | None  # between
    departs_at: datetime | None  # at_stop and not_started
    arrives_next: datetime | None


def estimate(stops: list[TripStop], now: datetime, delay_s: int = 0) -> Estimate | None:
    """Where the timetable, shifted by `delay_s`, puts the train at `now`. The service day
    is today's, or yesterday's for a train still running after midnight. None when the
    trip has no usable times or does not run around now."""
    if not stops or stops[0].departure_s is None or stops[-1].arrival_s is None:
        return None

    def dep(day: date, s: TripStop) -> datetime:
        secs = s.departure_s if s.departure_s is not None else s.arrival_s
        return add_seconds(at_service_time(day, secs or 0), delay_s)

    def arr(day: date, s: TripStop) -> datetime:
        secs = s.arrival_s if s.arrival_s is not None else s.departure_s
        return add_seconds(at_service_time(day, secs or 0), delay_s)

    today = now.astimezone(MADRID).date()
    day = next(
        (
            d
            for d in (today, today - timedelta(days=1))
            if dep(d, stops[0]) - timedelta(hours=3) <= now <= arr(d, stops[-1])
        ),
        None,
    )
    if day is None:
        return None
    if now < dep(day, stops[0]):
        nxt = stops[1] if len(stops) > 1 else None
        return Estimate("not_started", stops[0], nxt, None, dep(day, stops[0]), None)
    for i, s in enumerate(stops[1:], start=1):
        prev = stops[i - 1]
        if now < arr(day, s):
            return Estimate("between", prev, s, dep(day, prev), None, arr(day, s))
        if now < dep(day, s) and i < len(stops) - 1:
            nxt = stops[i + 1]
            return Estimate("at_stop", s, nxt, None, dep(day, s), arr(day, nxt))
    return Estimate("finished", stops[-1], None, None, None, None)


def locate(
    trip_id: str,
    stops: list[TripStop],
    snap: FeedSnapshot | None,
    now: datetime,
    from_stop: str | None = None,
) -> TripPosition:
    """Where Renfe trip `trip_id` ('cercanias:<native>') is now. `stops` is its timetable."""
    native = trip_id.partition(":")[2]
    fresh = renfe_freshness(snap, now)
    base = TripPosition(
        trip_id=trip_id,
        status="unavailable",
        message="",
        board_index=_board_index(stops, from_stop),
        freshness=fresh,
        source=renfe.SOURCE,
        attribution=renfe.ATTRIBUTION,
        observed_at=(snap.source_timestamp or snap.retrieved_at) if snap else None,
    )

    def unavailable(reason: Reason, message: str) -> TripPosition:
        return base.model_copy(update={"reason": reason, "message": message})

    def estimated(delay_s: int | None, why: str) -> TripPosition:
        e = estimate(stops, now, delay_s or 0)
        if e is None or e.state == "finished":
            return unavailable("not_running", tr("pos.not_running"))
        if e.state == "not_started" and e.departs_at is not None:
            at = e.departs_at.astimezone(MADRID).strftime("%H:%M")
            return unavailable("not_started", tr("pos.not_started", stop=e.last.name, time=at))
        board = base.board_index
        common: dict[str, object] = {
            "kind": "estimated",
            "last_stop": e.last.ref(),
            "next_stop": e.nxt.ref() if e.nxt else None,
            "progress_basis": "timetable",
            "delay_s": delay_s,
            "stops_away": board - e.last.index if board is not None else None,
            "expected_at_next": e.arrives_next,
            "observed_at": now,  # when it was estimated; the app hides it if polling stops
            "poll_after_s": ESTIMATE_POLL_AFTER_S,
        }
        if e.state == "at_stop":
            return base.model_copy(
                update=common
                | {
                    "status": "at_stop",
                    "progress": 0.0,
                    "departs_at": e.departs_at,
                    "message": tr("pos.estimated_at", stop=e.last.name, why=why),
                }
            )
        if e.nxt is None or e.left_at is None or e.arrives_next is None:
            return unavailable("not_running", tr("pos.not_running"))
        run = (e.arrives_next - e.left_at).total_seconds()
        progress = (now - e.left_at).total_seconds() / run if run > 0 else 0.5
        return base.model_copy(
            update=common
            | {
                "status": "between",
                "progress": round(max(0.05, min(0.95, progress)), 3),
                "segment_run_s": round(run) if run > 0 else None,
                "left_at": e.left_at,
                "message": tr("pos.estimated_between", a=e.last.name, b=e.nxt.name, why=why),
            }
        )

    if snap is None or not is_usable(fresh):
        return estimated(None, tr("pos.why_no_live_data"))
    tu = snap.trips.get(native)
    if tu is not None and tu.cancelled:
        return unavailable("cancelled", tr("pos.cancelled"))
    vehicle = snap.vehicles.get(native)
    by_native = {s.native_id: s for s in stops}
    last = by_native.get(vehicle.stop_id) if vehicle and vehicle.stop_id else None
    if vehicle is None or last is None:
        if tu is not None and tu.delay_s is not None:
            return estimated(tu.delay_s, tr("pos.why_delay"))
        return estimated(None, tr("pos.why_no_position"))

    base = base.model_copy(
        update={
            "kind": "live",
            "delay_s": tu.delay_s if tu is not None else None,
            "stops_away": base.board_index - last.index if base.board_index is not None else None,
            "last_stop": last.ref(),
        }
    )
    nxt = stops[last.index + 1] if last.index + 1 < len(stops) else None
    run_s = (
        nxt.arrival_s - last.departure_s
        if nxt is not None and nxt.arrival_s is not None and last.departure_s is not None
        else None
    )
    expected = (
        tu.stop_time if tu is not None and nxt is not None and tu.stop_id == nxt.native_id else None
    )
    # Renfe mostly reports a train at its station's coordinates until it reaches the next
    # one (live check, 2026-11-10), so "near the station" does not mean "still there".
    # Unless it says STOPPED_AT, a train past its expected departure has left.
    due_to_have_left = (
        expected is not None and run_s is not None and now >= add_seconds(expected, -run_s)
    )
    gps, last_pt = _pt(vehicle.lat, vehicle.lon), _pt(last.lat, last.lon)
    near = distance_m(gps, last_pt) <= AT_STOP_M if gps and last_pt else None
    stopped = vehicle.current_status == "STOPPED_AT"
    if nxt is None or (stopped if near is None else near and (stopped or not due_to_have_left)):
        return base.model_copy(
            update={
                "status": "at_stop",
                "message": tr("pos.at", stop=last.name),
                "next_stop": nxt.ref() if nxt else None,
                "progress": 0.0,
                "progress_basis": "gps" if gps else None,
            }
        )

    progress: float | None = None
    basis: Literal["gps", "timetable"] | None = None
    next_pt = _pt(nxt.lat, nxt.lon)
    if gps and last_pt and next_pt and not near:
        t, off = project(gps, last_pt, next_pt)
        if off <= MAX_OFF_LINE_M:
            progress, basis = t, "gps"
    if progress is None and expected is not None and run_s:
        progress, basis = 1 - (expected - now).total_seconds() / run_s, "timetable"
    if progress is not None:
        # Between stations: never drawn on top of either of them.
        progress = round(max(0.05, min(0.95, progress)), 3)
    return base.model_copy(
        update={
            "status": "between",
            "message": tr("pos.between", a=last.name, b=nxt.name),
            "next_stop": nxt.ref(),
            "progress": progress,
            "progress_basis": basis,
            "segment_run_s": run_s if run_s and run_s > 0 else None,
            "expected_at_next": expected,
            "left_at": add_seconds(expected, -run_s) if expected and run_s else None,
        }
    )


# ---------------------------------------------------------------------------
# Static timetable of one trip (a dependency, so tests can replace it)


class TripTimetable:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    async def stops(self, feed: str, native_trip: str) -> list[TripStop]:
        rows = await self.pool.fetch(
            """
            SELECT st.stop_id AS native_id, s.id, s.root_id, s.name, s.lat, s.lon,
                   st.arrival_s, st.departure_s
            FROM feed_version fv
            JOIN stop_time st ON st.feed_version_id = fv.id AND st.trip_id = $2
            JOIN stop s ON s.feed_version_id = fv.id AND s.native_id = st.stop_id
            WHERE fv.is_active AND fv.source = $1
            ORDER BY st.stop_sequence
            """,
            feed,
            native_trip,
        )
        return [
            TripStop(
                index=i,
                native_id=r["native_id"],
                stop_id=r["id"],
                root_id=r["root_id"],
                name=display_name(r["name"]),
                lat=r["lat"],
                lon=r["lon"],
                arrival_s=r["arrival_s"],
                departure_s=r["departure_s"],
            )
            for i, r in enumerate(rows)
        ]


def get_trip_timetable(pool: Annotated[asyncpg.Pool, Depends(get_pool)]) -> TripTimetable:
    return TripTimetable(pool)


# ---------------------------------------------------------------------------
# The whole route of one trip (`GET /trips/{trip_id}`): every stop from origin to terminus,
# for the trip screen that opens from a journey leg.


class TripStopTime(BaseModel):
    index: int
    stop_id: str
    name: str
    # Timetable times on the journey's day (aligned to your boarding time, see trip_details).
    arrival: datetime | None = None
    departure: datetime | None = None


class TripDetails(BaseModel):
    trip_id: str
    stops: list[TripStopTime]
    board_index: int | None = None
    alight_index: int | None = None
    # Renfe's current delay for this train, when a fresh trip update has one. The times
    # above stay the timetable's; the app shows the delay next to the stops still to come.
    delay_s: int | None = None
    freshness: Freshness | None = None
    source: str | None = None
    attribution: str | None = None


def trip_details(
    trip_id: str,
    stops: list[TripStop],
    departure: datetime | None,
    from_stop: str | None,
    to_stop: str | None,
    snap: FeedSnapshot | None,
    now: datetime,
) -> TripDetails:
    """The trip's stops with times. With `departure` (your scheduled time at `from_stop`),
    the times are those of that day; trips that run at a frequency share one template
    timetable, so all times are shifted to match your boarding time."""
    board = _board_index(stops, from_stop)
    alight = _board_index(stops, to_stop)
    if alight is not None and board is not None and alight <= board:
        alight = None
    anchor = stops[board] if board is not None else stops[0]
    anchor_s = anchor.departure_s if anchor.departure_s is not None else anchor.arrival_s
    ref = departure or now
    day = ref.astimezone(MADRID).date()
    if departure is not None and anchor_s is not None:
        # A trip still running after midnight belongs to the previous service day.
        day = min(
            (day, day - timedelta(days=1)),
            key=lambda d: abs((at_service_time(d, anchor_s) - departure).total_seconds()),
        )
        shift = departure - at_service_time(day, anchor_s)
    else:
        shift = timedelta(0)

    def at(secs: int | None) -> datetime | None:
        return at_service_time(day, secs) + shift if secs is not None else None

    feed = trip_id.partition(":")[0]
    delay_s: int | None = None
    fresh: Freshness | None = None
    source = attribution = None
    if feed == "cercanias":
        fresh = renfe_freshness(snap, now)
        source, attribution = renfe.SOURCE, renfe.ATTRIBUTION
        tu = snap.trips.get(trip_id.partition(":")[2]) if snap and is_usable(fresh) else None
        delay_s = tu.delay_s if tu is not None else None
    return TripDetails(
        trip_id=trip_id,
        stops=[
            TripStopTime(
                index=s.index,
                stop_id=s.stop_id,
                name=s.name,
                arrival=at(s.arrival_s),
                departure=at(s.departure_s),
            )
            for s in stops
        ],
        board_index=board,
        alight_index=alight,
        delay_s=delay_s,
        freshness=fresh,
        source=source,
        attribution=attribution,
    )


@router.get("/trips/{trip_id}", response_model=TripDetails)
async def trip_route(
    trip_id: Annotated[
        str, Path(max_length=80, description="Journey leg trip id, e.g. cercanias:1012L27301C4a")
    ],
    rt: Annotated[Realtime, Depends(get_realtime)],
    timetable: Annotated[TripTimetable, Depends(get_trip_timetable)],
    from_stop: Annotated[str | None, Query(max_length=80, description="Your boarding stop")] = None,
    to_stop: Annotated[str | None, Query(max_length=80, description="Your alighting stop")] = None,
    departure: Annotated[
        datetime | None,
        Query(description="Your scheduled departure at from_stop (ISO), to pick the day"),
    ] = None,
) -> TripDetails:
    """Every stop of a trip, from its origin to its terminus, with timetable times. The
    train's position comes from `/trips/{trip_id}/position`."""
    feed, _, native = trip_id.partition(":")
    if not native:
        raise HTTPException(status_code=422, detail="trip_id must look like 'cercanias:<id>'")
    stops = await timetable.stops(feed, native)
    if not stops:
        raise HTTPException(status_code=404, detail=f"Unknown trip {trip_id}")
    if departure is not None and departure.tzinfo is None:
        departure = departure.replace(tzinfo=MADRID)
    snap = await rt.renfe_snapshot() if feed == "cercanias" else None
    return trip_details(trip_id, stops, departure, from_stop, to_stop, snap, now_utc())


@router.get("/trips/{trip_id}/position", response_model=TripPosition)
async def trip_position(
    trip_id: Annotated[
        str, Path(max_length=80, description="Journey leg trip id, e.g. cercanias:1012L27301C4a")
    ],
    rt: Annotated[Realtime, Depends(get_realtime)],
    timetable: Annotated[TripTimetable, Depends(get_trip_timetable)],
    from_stop: Annotated[
        str | None,
        Query(max_length=80, description="Your boarding stop, to count the stops still to come"),
    ] = None,
) -> TripPosition:
    """Where the train of a journey leg is now, from Renfe's live vehicle positions.

    Only Renfe Cercanías publishes positions. For other operators the answer says why
    there is none (`status: unavailable`, `reason: not_supported`)."""
    feed, _, native = trip_id.partition(":")
    if not native:
        raise HTTPException(status_code=422, detail="trip_id must look like 'cercanias:<id>'")
    if feed != "cercanias":
        return not_supported(trip_id, feed)
    stops = await timetable.stops(feed, native)
    if not stops:
        raise HTTPException(status_code=404, detail=f"Unknown trip {trip_id}")
    return locate(trip_id, stops, await rt.renfe_snapshot(), now_utc(), from_stop)
