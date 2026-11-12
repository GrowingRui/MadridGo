"""Where your EMT bus is now: `GET /buses/position` (Phase 5, live trip map for buses).

EMT publishes no vehicle feed. Its arrivals for a stop list the next buses of each line
(usually two) with the bus id, the seconds and the metres *along the route* to that stop
(`DistanceBus`), and the bus's last GPS fix. Live check of 2026-11-12 (stop 72, 7 polls 20 s
apart): `DistanceBus` goes down at every poll, while the GPS fix changes only every 40-80 s
and is nearly always within 60 m of a stop. So:

- Before you board, the bus is found in your boarding stop's arrivals: how far and how soon,
  plus its GPS fix (roughly the last stop it served), which the app draws on the map.
- Once it has passed your boarding stop, EMT no longer lists it there; it is then found by
  its bus id in your alighting stop's arrivals, and the app places it on the leg's own path
  by the metres still to go.

Answers come from the shared EMT cache (one EMT call per stop per 20 s, whoever asks).
A bus that cannot be found, or data that is too old, is said so: never a guessed position.
"""

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.i18n import tr
from app.realtime import emt
from app.realtime.board import add_seconds, emt_freshness
from app.realtime.emt import LiveFetch
from app.realtime.freshness import is_usable
from app.realtime.models import EmtArrival, EmtArrivals, Freshness
from app.realtime.service import Realtime, get_realtime, now_utc

router = APIRouter(tags=["buses"])

POLL_AFTER_S = emt.REUSE_S
# A bus listed at your alighting stop further away than the leg itself (plus this margin)
# has not reached your boarding stop yet: it is a later bus with the same id, or a mismatch.
ROUTE_MARGIN_M = 300

BusStatus = Literal["approaching", "riding", "unavailable"]
BusReason = Literal["not_configured", "not_found", "outdated"]


class BusPosition(BaseModel):
    status: BusStatus
    reason: BusReason | None = None
    message: str
    line: str
    vehicle_id: str | None = None
    # approaching: to your boarding stop. riding: to your alighting stop. Along the route.
    distance_m: int | None = None
    seconds: int | None = None  # until the bus reaches that stop, when EMT answered
    expected_at: datetime | None = None
    # approaching only: the bus's last GPS fix (roughly the last stop it served).
    lat: float | None = None
    lon: float | None = None
    observed_at: datetime | None = None  # when EMT answered (EMT gives no observation time)
    freshness: Freshness | None = None
    source: str = emt.SOURCE
    attribution: str = emt.ATTRIBUTION
    poll_after_s: int = POLL_AFTER_S


def _code(stop_id: str) -> str | None:
    feed, _, native = stop_id.partition(":")
    return native if feed == "emt" and native else None


def _found(
    status: BusStatus, line: str, a: EmtArrival, data: EmtArrivals, f: Freshness
) -> BusPosition:
    when = add_seconds(data.retrieved_at, a.seconds) if a.seconds is not None else None
    gps = status == "approaching" and a.lat is not None and a.lon is not None
    return BusPosition(
        status=status,
        message="",
        line=line,
        vehicle_id=a.vehicle_id,
        distance_m=a.distance_m,
        seconds=a.seconds,
        expected_at=when,
        lat=a.lat if gps else None,
        lon=a.lon if gps else None,
        observed_at=data.retrieved_at,
        freshness=f,
    )


def _none(
    line: str, reason: BusReason, f: Freshness | None = None, **params: object
) -> BusPosition:
    return BusPosition(
        status="unavailable",
        reason=reason,
        message=tr(f"bus.{reason}", **params),
        line=line,
        freshness=f,
    )


def locate_bus(
    line: str,
    board_name: str,
    board: LiveFetch,
    alight: LiveFetch | None,
    vehicle: str | None,
    route_m: int | None,
    now: datetime,
) -> BusPosition:
    """Find the bus in the boarding stop's arrivals, else (by its id) in the alighting
    stop's. `alight` is only needed when the bus is not at the boarding stop."""
    f = emt_freshness(board.data, now)
    if board.data is None or not is_usable(f):
        return _none(line, "outdated", f)
    mine = [a for a in board.data.arrivals if a.line == line and a.seconds is not None]
    match = next((a for a in mine if a.vehicle_id == vehicle), None) if vehicle else None
    if match is None and not vehicle and mine:
        match = mine[0]  # bus not known yet: the next one of the line
    if match is not None:
        return _found("approaching", line, match, board.data, f)
    if vehicle and alight is not None:
        fa = emt_freshness(alight.data, now)
        if alight.data is not None and is_usable(fa):
            for a in alight.data.arrivals:
                if a.vehicle_id != vehicle or a.line != line:
                    continue
                if route_m is not None and (a.distance_m or 0) > route_m + ROUTE_MARGIN_M:
                    break  # not yet at your boarding stop: not this leg's bus
                return _found("riding", line, a, alight.data, fa)
    return _none(line, "not_found", f, stop=board_name)


@router.get("/buses/position", response_model=BusPosition)
async def bus_position(
    rt: Annotated[Realtime, Depends(get_realtime)],
    line: Annotated[str, Query(max_length=10, description="EMT line as shown, e.g. 27")],
    from_stop: Annotated[str, Query(max_length=40, description="Boarding stop, e.g. emt:72")],
    to_stop: Annotated[str, Query(max_length=40, description="Alighting stop")],
    vehicle: Annotated[
        str | None, Query(max_length=12, description="EMT bus id, once known")
    ] = None,
    route_m: Annotated[
        int | None, Query(ge=0, le=100_000, description="Length of the leg, metres")
    ] = None,
    from_name: Annotated[str | None, Query(max_length=120)] = None,
) -> BusPosition:
    """Where the bus of an EMT journey leg is now: on its way to your boarding stop, or
    on the leg (`riding`, metres still to go to your alighting stop)."""
    board_code, alight_code = _code(from_stop), _code(to_stop)
    if board_code is None or alight_code is None:
        return _none(line, "not_found", stop=from_name or from_stop)
    if rt.emt_service is None:
        return _none(line, "not_configured")
    board = await rt.emt_arrivals(board_code)
    now = now_utc()
    pos = locate_bus(line, from_name or board_code, board, None, vehicle, route_m, now)
    if pos.reason == "not_found" and vehicle:
        alight = await rt.emt_arrivals(alight_code)
        pos = locate_bus(line, from_name or board_code, board, alight, vehicle, route_m, now)
    return pos
