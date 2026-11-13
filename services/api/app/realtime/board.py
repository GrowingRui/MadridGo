"""Applying real-time data to a stop board. Pure functions: no I/O, the clock is an argument.

Rules (RELIABILITY_STRATEGY.md):
- Only FRESH or DELAYED_UPDATE data changes what the board shows; STALE data falls back to
  the timetable and says so (R4).
- A trip the feed does not mention stays Scheduled (R3).
- Renfe gives one stop update and a trip delay. At later stops the delay is carried
  forward and marked `estimated_from_trip_delay`; at earlier stops the train has passed.
"""

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

from pydantic import BaseModel

from app.i18n import tr
from app.realtime import emt, renfe
from app.realtime.freshness import THRESHOLDS, assess, is_usable
from app.realtime.models import (
    AlertSnapshot,
    EmtArrival,
    EmtArrivals,
    FeedSnapshot,
    Freshness,
    FreshnessState,
    RealtimeInfo,
    ServiceAlert,
)
from app.timetable import MADRID

SourceState = Literal["live", "delayed_update", "stale", "unavailable", "not_available"]


class SourceStatus(BaseModel):
    """Real-time status of one operator at this stop, shown above the departures."""

    feed: str  # static feed key: cercanias, emt, interurban, ...
    operator: str
    source: str | None  # real-time source, if MadridGo has one for this operator
    status: SourceState
    message: str
    freshness: Freshness | None = None
    retrieved_at: datetime | None = None
    source_timestamp: datetime | None = None
    attribution: str | None = None


# Static feed -> why there is no live data (message keys in app/i18n.py), for operators
# without an authorized source.
NO_REALTIME = {
    "metro": "rt.none.metro",
    "ml": "rt.none.ml",
    "interurban": "rt.none.bus",
    "urban": "rt.none.bus",
}


_STATE: dict[FreshnessState, SourceState] = {
    "FRESH": "live",
    "DELAYED_UPDATE": "delayed_update",
    "STALE": "stale",
    "UNAVAILABLE": "unavailable",
}


def _state(f: Freshness) -> SourceState:
    return _STATE[f.state]


def _minutes(age_s: int | None) -> str:
    if age_s is None:
        return ""
    return f"{age_s} s" if age_s < 120 else f"{age_s // 60} min"


def live_status(
    feed: str,
    operator: str,
    source: str,
    attribution: str,
    f: Freshness,
    retrieved_at: datetime | None,
    source_timestamp: datetime | None,
    error: str | None = None,
) -> SourceStatus:
    state = _state(f)
    if state == "live":
        msg = tr("rt.live", operator=operator)
    elif state == "delayed_update":
        msg = tr("rt.delayed_update", operator=operator, age=_minutes(f.age_s))
    elif state == "stale":
        msg = tr("rt.stale", age=_minutes(f.age_s))
    else:
        msg = tr("rt.unavailable")
    if error == "not_configured":
        state, msg = "unavailable", tr("rt.not_configured")
    return SourceStatus(
        feed=feed,
        operator=operator,
        source=source,
        status=state,
        message=msg,
        freshness=f,
        retrieved_at=retrieved_at,
        source_timestamp=source_timestamp,
        attribution=attribution,
    )


def no_realtime_status(feed: str, operator: str) -> SourceStatus:
    return SourceStatus(
        feed=feed,
        operator=operator,
        source=None,
        status="not_available",
        message=tr(NO_REALTIME.get(feed, "rt.none.default")),
    )


def add_seconds(t: datetime, seconds: int) -> datetime:
    """Absolute addition. Adding a timedelta to a Madrid-zoned datetime adds wall-clock time,
    which is off by an hour across a DST change (R14)."""
    return (t.astimezone(UTC) + timedelta(seconds=seconds)).astimezone(MADRID)


# --- Renfe ---------------------------------------------------------------------------------


def renfe_freshness(snap: FeedSnapshot | None, now: datetime) -> Freshness:
    if snap is None:
        return assess(now, None, None, THRESHOLDS[renfe.SOURCE])
    return assess(now, snap.source_timestamp, snap.retrieved_at, THRESHOLDS[renfe.SOURCE])


@dataclass(frozen=True)
class TrainState:
    info: RealtimeInfo | None  # None: show the scheduled time
    passed: bool = False  # the train is already beyond this stop


def renfe_train(
    trip_id: str,
    native_stop_id: str,
    scheduled: datetime,
    snap: FeedSnapshot | None,
    f: Freshness,
) -> TrainState:
    if snap is None or not is_usable(f):
        return TrainState(None)
    t = snap.trips.get(trip_id)
    if t is None:
        return TrainState(None)
    base = RealtimeInfo(
        classification="CANCELLED",
        source=renfe.SOURCE,
        retrieved_at=snap.retrieved_at,
        source_timestamp=snap.source_timestamp,
        freshness=f,
    )
    if t.cancelled:
        return TrainState(base)

    delay = t.delay_s
    at_update_stop = t.stop_id == native_stop_id
    vehicle = snap.vehicles.get(trip_id)
    at_this_stop = vehicle is not None and vehicle.stop_id == native_stop_id
    # Renfe names the next station in the trip update even while the train still stands at
    # this one (found 2026-11-13: trains waiting at Parla, their first station, all showed as
    # gone). Stopped here, it has not passed.
    stopped_here = at_this_stop and vehicle is not None and vehicle.current_status == "STOPPED_AT"
    if t.stop_time is not None and delay is not None and not stopped_here:
        # Times along a trip only increase, so a stop scheduled before the next stop's
        # scheduled arrival lies behind the train.
        if scheduled < t.stop_time - timedelta(seconds=delay):
            return TrainState(None, passed=True)
    elif delay is None and at_update_stop and t.stop_time is not None:
        delay = round((t.stop_time - scheduled).total_seconds())
    if delay is None:
        return TrainState(None)

    return TrainState(
        base.model_copy(
            update={
                "classification": "LIVE",
                "predicted_time": add_seconds(scheduled, delay),
                "delay_s": delay,
                "estimated_from_trip_delay": not at_update_stop,
                "vehicle_id": vehicle.vehicle_id if vehicle else None,
                "platform": vehicle.platform if vehicle and at_this_stop else None,
            }
        )
    )


# --- EMT -----------------------------------------------------------------------------------


def emt_freshness(data: EmtArrivals | None, now: datetime) -> Freshness:
    th = THRESHOLDS[emt.SOURCE]
    return assess(now, None, data.retrieved_at if data else None, th)


def emt_live(
    data: EmtArrivals | None, f: Freshness, now: datetime
) -> list[tuple[EmtArrival, datetime | None, RealtimeInfo]]:
    """(arrival, predicted time or None if beyond the horizon, provenance)."""
    if data is None or not is_usable(f):
        return []
    out = []
    for a in data.arrivals:
        when = add_seconds(data.retrieved_at, a.seconds) if a.seconds is not None else None
        if when is not None and when < now - timedelta(seconds=30):
            continue  # from an older answer: that bus has gone
        info = RealtimeInfo(
            classification="LIVE",
            source=emt.SOURCE,
            retrieved_at=data.retrieved_at,
            source_timestamp=None,
            freshness=f,
            predicted_time=when,
            vehicle_id=a.vehicle_id,
        )
        out.append((a, when, info))
    return out


# --- Alerts --------------------------------------------------------------------------------

_RENFE_ROUTE = re.compile(r"^10T\d{4}(.+)$")


def renfe_line_of(route_id: str) -> str | None:
    """'10T0013C4a' -> 'C4a'."""
    m = _RENFE_ROUTE.match(route_id)
    return m.group(1) if m else None


def alerts_for_stop(
    snapshots: list[AlertSnapshot],
    lines_by_feed: dict[str, set[str]],
    native_stops_by_feed: dict[str, set[str]],
    now: datetime,
) -> list[ServiceAlert]:
    """Active alerts that name this stop or one of its lines."""
    out: list[ServiceAlert] = []
    for snap in snapshots:
        feed = "cercanias" if snap.source == renfe.ALERTS_SOURCE else "emt"
        lines = {s.lower() for s in lines_by_feed.get(feed, set())}
        stops = native_stops_by_feed.get(feed, set())
        if not lines and not stops:
            continue
        for a in snap.alerts:
            if not a.is_active(now):
                continue
            alert_lines = {
                (renfe_line_of(r) if feed == "cercanias" else r) or "" for r in a.route_ids
            }
            if {x.lower() for x in alert_lines} & lines or set(a.stop_ids) & stops:
                out.append(a)
    out.sort(key=lambda a: (bool(a.stop_ids), a.active_from or now), reverse=True)
    return out
