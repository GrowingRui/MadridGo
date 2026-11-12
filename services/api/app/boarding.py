"""Board a frequency bus at the stop nearest to you, not further along its route.

Found 2026-11-12 (Biblioteca Campus Sur UPM -> Conde de Casal): OTP sent the user 360 m to
Mediterráneo - Democracia for EMT line E, although the same bus stops 300 m away at
Polideportivo Campus Sur first. EMT publishes its lines as "every N min" (GTFS frequencies),
and OTP boards you a whole headway after you reach the stop, wherever that stop is. So a stop
further along the route costs the same wait and less time on the bus, and always wins.

For every walk that leads to a frequency leg (from your start, or from the vehicle you get off
at a change), this looks at that bus's earlier stops, asks OTP for the walk to the one nearest
to where the walk starts, and moves the boarding there when the walk is shorter and you still
make the bus. You get off at the same stop at the same time; the bus leg starts earlier by
the bus's own running time between the two stops (from the template trip's stop times).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Protocol

from app.otp import Walk
from app.realtime.board import add_seconds
from app.timetable import display_name
from app.trips import distance_m

if TYPE_CHECKING:
    from app.journeys import _Itinerary

# Stops further than this (straight line) from where you start are not worth a look.
MAX_CROW_M = 800
# A nearer stop must save at least this much walking, so tiny differences change nothing.
MIN_SAVING_M = 25


@dataclass(frozen=True)
class TripStop:
    """One stop of a trip, in order: its native id, name, place and departure (s of day)."""

    native: str
    name: str
    lat: float
    lon: float
    departure_s: int


class WalkPlanner(Protocol):
    async def walk(
        self, origin: tuple[float, float], destination: tuple[float, float]
    ) -> Walk | None: ...


def walks_to_frequency_buses(it: _Itinerary) -> list[int]:
    """Indexes of frequency legs reached by exactly one walk (at the start or at a change)."""
    drafts = it.drafts
    out = []
    for i in range(1, len(drafts)):
        d, w = drafts[i], drafts[i - 1]
        if (
            w.leg.mode == "walk"
            and (i == 1 or drafts[i - 2].leg.mode != "walk")
            and d.leg.headway_min is not None
            and d.leg.departure.status == "frequency"
            and d.feed is not None
            and d.trip_native is not None
            and w.leg.from_lat is not None
            and w.leg.from_lon is not None
        ):
            out.append(i)
    return out


def candidate(
    it: _Itinerary, index: int, stops: list[TripStop] | None
) -> tuple[TripStop, list[TripStop]] | None:
    """For the frequency leg `index` (reached by a walk): the earlier stop of that bus
    nearest to where the walk starts (straight line), with the stops between it and OTP's
    boarding stop (OTP's stop last). None when there is no nearer stop."""
    d, w = it.drafts[index], it.drafts[index - 1].leg
    if not stops or w.from_lat is None or w.from_lon is None:
        return None
    at = next((k for k, s in enumerate(stops) if s.native == d.from_native), None)
    if at is None or at == 0:
        return None
    here = (w.from_lat, w.from_lon)
    now_m = distance_m(here, (stops[at].lat, stops[at].lon))
    best: tuple[float, int] | None = None
    for k in range(at):
        m = distance_m(here, (stops[k].lat, stops[k].lon))
        if m <= MAX_CROW_M and m < now_m - MIN_SAVING_M and (best is None or m < best[0]):
            best = (m, k)
    if best is None:
        return None
    k = best[1]
    return stops[k], stops[k + 1 : at + 1]


def board_at(
    it: _Itinerary, index: int, stop: TripStop, passed: list[TripStop], walk: Walk
) -> bool:
    """Move the boarding of leg `index` (a frequency bus right after a walk) to `stop`,
    reached by `walk`. False (and nothing changed) when you could not reach it in time."""
    first, d = it.drafts[index - 1], it.drafts[index]
    leg = d.leg
    ride_s = passed[-1].departure_s - stop.departure_s
    if ride_s < 0:
        return False
    boarding = add_seconds(leg.departure.scheduled, -ride_s)
    # The walk starts when it did (your start, or when the vehicle before arrives).
    walk_end = add_seconds(first.leg.departure.scheduled, walk.duration_s)
    if walk_end > boarding:
        return False

    from app.journeys import LegStop, global_stop_id

    feed = d.feed or ""
    # The stops passed before OTP's boarding stop become stops of the ride.
    start = leg.departure.scheduled
    extra = [
        LegStop(
            name=display_name(s.name),
            stop_id=global_stop_id(f"{feed}:{s.native}"),
            time=add_seconds(start, s.departure_s - passed[-1].departure_s),
            lat=s.lat,
            lon=s.lon,
        )
        for s in passed
    ]
    extra[-1].name = leg.from_
    leg.intermediate = extra + leg.intermediate
    leg.departure = leg.departure.model_copy(update={"scheduled": boarding})
    leg.from_ = display_name(stop.name)
    leg.from_stop_id = global_stop_id(f"{feed}:{stop.native}")
    leg.from_lat, leg.from_lon = stop.lat, stop.lon
    leg.duration_min = max(0, round((leg.arrival.scheduled - boarding).total_seconds() / 60))
    if leg.distance_m is not None:
        points = [(stop.lat, stop.lon)] + [(s.lat, s.lon) for s in passed]
        leg.distance_m += round(
            sum(distance_m(a, b) for a, b in zip(points, points[1:], strict=False))
        )
    # The ride's path from the new stop: straight through the stops passed, then OTP's.
    if leg.geometry:
        path = [(stop.lat, stop.lon)] + [(s.lat, s.lon) for s in passed[:-1]]
        leg.geometry = encode(path + decode(leg.geometry))
    d.from_native = stop.native
    d.duration_s += ride_s
    if d.otp_start is not None:
        d.otp_start -= timedelta(seconds=ride_s)

    wl = first.leg
    wl.to, wl.to_stop_id = leg.from_, leg.from_stop_id
    wl.to_lat, wl.to_lon = stop.lat, stop.lon
    wl.arrival = wl.arrival.model_copy(update={"scheduled": walk_end})
    wl.duration_min = max(0, round(walk.duration_s / 60))
    wl.distance_m = round(walk.distance_m)
    wl.geometry = walk.geometry
    first.duration_s = walk.duration_s
    return True


async def board_nearer(
    its: list[_Itinerary],
    trip_stops: dict[tuple[str, str], list[TripStop]],
    otp: WalkPlanner,
) -> None:
    """Move each frequency bus reached by a walk to its nearest earlier stop when the walk
    there is shorter (see the module docstring). One OTP walk per distinct pair of places."""
    walks: dict[tuple[float, float, str], Walk | None] = {}
    for it in its:
        for i in walks_to_frequency_buses(it):
            d, w = it.drafts[i], it.drafts[i - 1].leg
            found = candidate(it, i, trip_stops.get((d.feed or "", d.trip_native or "")))
            if found is None or w.from_lat is None or w.from_lon is None:
                continue
            stop, passed = found
            here = (w.from_lat, w.from_lon)
            key = (round(here[0], 5), round(here[1], 5), stop.native)
            if key not in walks:
                walks[key] = (
                    Walk(
                        distance_m=distance_m(here, (stop.lat, stop.lon)),
                        duration_s=0,
                        geometry=None,
                    )
                    if distance_m(here, (stop.lat, stop.lon)) < 5
                    else await otp.walk(here, (stop.lat, stop.lon))
                )
            walk = walks[key]
            current = w.distance_m
            if walk is None or current is None or walk.distance_m > current - MIN_SAVING_M:
                continue
            board_at(it, i, stop, passed, walk)


# Google encoded polylines (precision 5), as OTP's legGeometry.


def decode(s: str) -> list[tuple[float, float]]:
    """Polyline -> [(lat, lon)]."""
    out: list[tuple[float, float]] = []
    i = lat = lon = 0
    while i < len(s):
        vals = []
        for _ in range(2):
            shift = result = 0
            while True:
                b = ord(s[i]) - 63
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


def encode(points: list[tuple[float, float]]) -> str:
    """[(lat, lon)] -> polyline."""
    out: list[str] = []
    plat = plon = 0
    for lat, lon in points:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)
