"""Renfe Cercanías GTFS-RT (https://gtfsrt.renfe.com, CC BY 4.0): parsing and polling.

Observed 2026-11-09 (DATA_SOURCE_ANALYSIS.md §4): each Madrid trip update carries one stop
update (the train's next stop) and a trip-level `delay`; cancelled trips have
schedule_relationship CANCELED and no stop updates. Trip IDs match the static GTFS exactly.
"""

import re
from collections.abc import Iterable
from datetime import UTC, datetime

from google.transit import gtfs_realtime_pb2 as rt

from app.realtime.models import (
    AlertSnapshot,
    FeedSnapshot,
    ServiceAlert,
    TripRealtime,
    VehicleRealtime,
)

SOURCE = "renfe_gtfsrt"
ALERTS_SOURCE = "renfe_alerts"
OPERATOR = "RENFE_CERCANIAS"
ATTRIBUTION = "Renfe (CC BY 4.0)"
TRIP_UPDATES_URL = "https://gtfsrt.renfe.com/trip_updates.pb"
VEHICLE_POSITIONS_URL = "https://gtfsrt.renfe.com/vehicle_positions.pb"
ALERTS_URL = "https://gtfsrt.renfe.com/alerts.pb"

# The feeds cover every Renfe network in Spain. Madrid trips start with "10" (the Madrid
# nucleus code) and Madrid routes with "10T".
MADRID_TRIP_PREFIX = "10"
MADRID_ROUTE_PREFIX = "10T"

_PLATFORM = re.compile(r"PLATF\.\((\w+)\)")
_CANCELED = rt.TripDescriptor.ScheduleRelationship.Value("CANCELED")


def _ts(seconds: int) -> datetime | None:
    return datetime.fromtimestamp(seconds, UTC) if seconds > 0 else None


def _parse(data: bytes) -> rt.FeedMessage:
    msg = rt.FeedMessage()
    msg.ParseFromString(data)
    return msg


def parse_trip_updates(data: bytes, retrieved_at: datetime) -> FeedSnapshot:
    msg = _parse(data)
    trips: dict[str, TripRealtime] = {}
    for e in msg.entity:
        if not e.HasField("trip_update"):
            continue
        tu = e.trip_update
        trip_id = tu.trip.trip_id
        if not trip_id.startswith(MADRID_TRIP_PREFIX):
            continue
        cancelled = tu.trip.schedule_relationship == _CANCELED
        delay = tu.delay if tu.HasField("delay") else None
        stop_id = stop_time = None
        if tu.stop_time_update:
            stu = tu.stop_time_update[0]
            stop_id = stu.stop_id or None
            ev = stu.arrival if stu.HasField("arrival") else stu.departure
            stop_time = _ts(ev.time) if ev.HasField("time") else None
            if delay is None and ev.HasField("delay"):
                delay = ev.delay
        trips[trip_id] = TripRealtime(
            trip_id=trip_id,
            entity_id=e.id,
            cancelled=cancelled,
            delay_s=delay,
            stop_id=stop_id,
            stop_time=stop_time,
        )
    return FeedSnapshot(
        source=SOURCE,
        source_timestamp=_ts(msg.header.timestamp),
        retrieved_at=retrieved_at,
        trips=trips,
    )


def parse_vehicle_positions(data: bytes) -> tuple[datetime | None, dict[str, VehicleRealtime]]:
    msg = _parse(data)
    out: dict[str, VehicleRealtime] = {}
    for e in msg.entity:
        if not e.HasField("vehicle"):
            continue
        v = e.vehicle
        trip_id = v.trip.trip_id
        if not trip_id.startswith(MADRID_TRIP_PREFIX):
            continue
        label = v.vehicle.label or None
        m = _PLATFORM.search(label or "")
        out[trip_id] = VehicleRealtime(
            trip_id=trip_id,
            vehicle_id=v.vehicle.id or None,
            label=label,
            platform=m.group(1) if m else None,
            lat=v.position.latitude if v.HasField("position") else None,
            lon=v.position.longitude if v.HasField("position") else None,
            current_status=(
                rt.VehiclePosition.VehicleStopStatus.Name(v.current_status)
                if v.HasField("current_status")
                else None
            ),
            stop_id=v.stop_id or None,
            timestamp=_ts(v.timestamp),
        )
    return _ts(msg.header.timestamp), out


def _text(ts: rt.TranslatedString, prefer: Iterable[str] = ("es", "en")) -> str | None:
    by_lang = {t.language: t.text for t in ts.translation if t.text}
    for lang in prefer:
        if lang in by_lang:
            return str(by_lang[lang]).strip()
    first = next(iter(by_lang.values()), None)
    return str(first) if first is not None else None


def parse_alerts(data: bytes, retrieved_at: datetime, madrid_stops: set[str]) -> AlertSnapshot:
    """Madrid alerts only: those naming a Madrid route or a stop in `madrid_stops`."""
    msg = _parse(data)
    alerts = []
    for e in msg.entity:
        if not e.HasField("alert"):
            continue
        a = e.alert
        routes = sorted({ie.route_id for ie in a.informed_entity if ie.route_id})
        stops = sorted({ie.stop_id for ie in a.informed_entity if ie.stop_id})
        madrid_routes = [r for r in routes if r.startswith(MADRID_ROUTE_PREFIX)]
        madrid_stop_ids = [s for s in stops if s in madrid_stops]
        if not madrid_routes and not madrid_stop_ids:
            continue
        periods = list(a.active_period)
        starts = [p.start for p in periods if p.start]
        ends = [p.end for p in periods if p.end]
        alerts.append(
            ServiceAlert(
                source=ALERTS_SOURCE,
                source_alert_id=e.id,
                operator=OPERATOR,
                header=_text(a.header_text),
                description=_text(a.description_text),
                url=_text(a.url),
                cause=rt.Alert.Cause.Name(a.cause) if a.HasField("cause") else None,
                effect=rt.Alert.Effect.Name(a.effect) if a.HasField("effect") else None,
                active_from=_ts(min(starts)) if starts else None,
                # Open-ended if any period has no end.
                active_to=_ts(max(ends)) if ends and len(ends) == len(periods) else None,
                route_ids=madrid_routes,
                stop_ids=madrid_stop_ids,
                source_timestamp=_ts(msg.header.timestamp),
                retrieved_at=retrieved_at,
            )
        )
    return AlertSnapshot(
        source=ALERTS_SOURCE,
        source_timestamp=_ts(msg.header.timestamp),
        retrieved_at=retrieved_at,
        alerts=alerts,
    )
