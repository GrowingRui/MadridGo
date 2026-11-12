"""Normalized real-time records shared by adapters, the cache and the API."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

Classification = Literal["LIVE", "SCHEDULED", "FREQUENCY_ESTIMATE", "CANCELLED", "UNKNOWN"]
FreshnessState = Literal["FRESH", "DELAYED_UPDATE", "STALE", "UNAVAILABLE"]
# Which clock the age is measured against: the source's own observation time, or (when the
# source gives none, as with EMT) the moment MadridGo retrieved the data.
AgeBasis = Literal["source", "retrieved"]


class Freshness(BaseModel):
    state: FreshnessState
    age_s: int | None  # never negative
    age_basis: AgeBasis | None
    anomaly: str | None = None  # e.g. "source_timestamp_in_future"


class RealtimeInfo(BaseModel):
    """Provenance of one live value. `source` and `retrieved_at` are mandatory, so a live
    classification can never be produced without them (RELIABILITY_STRATEGY.md §2)."""

    classification: Literal["LIVE", "CANCELLED"]
    source: str
    retrieved_at: datetime
    source_timestamp: datetime | None
    freshness: Freshness
    predicted_time: datetime | None = None
    delay_s: int | None = None  # null when no schedule to compare with, never a fake 0
    # True when the time is the train's current delay applied to a later stop, not a
    # prediction the source made for this stop.
    estimated_from_trip_delay: bool = False
    vehicle_id: str | None = None
    platform: str | None = None


# --- Renfe GTFS-RT ------------------------------------------------------------------------


class TripRealtime(BaseModel):
    trip_id: str
    entity_id: str
    cancelled: bool
    delay_s: int | None
    stop_id: str | None  # the stop the update refers to (Renfe: the next stop)
    stop_time: datetime | None  # predicted arrival or departure at that stop


class VehicleRealtime(BaseModel):
    trip_id: str
    vehicle_id: str | None
    label: str | None
    platform: str | None
    lat: float | None
    lon: float | None
    current_status: str | None
    stop_id: str | None
    timestamp: datetime | None


class FeedSnapshot(BaseModel):
    """One poll of a feed-style source, as stored in the cache."""

    source: str
    source_timestamp: datetime | None  # GTFS-RT header timestamp
    retrieved_at: datetime
    trips: dict[str, TripRealtime] = {}
    vehicles: dict[str, VehicleRealtime] = {}


# --- Alerts --------------------------------------------------------------------------------


class ServiceAlert(BaseModel):
    source: str
    source_alert_id: str
    operator: str
    header: str | None
    description: str | None
    url: str | None
    cause: str | None
    effect: str | None
    active_from: datetime | None
    active_to: datetime | None
    route_ids: list[str] = []  # native route ids (Renfe) or line labels (EMT)
    stop_ids: list[str] = []  # native stop ids
    source_timestamp: datetime | None
    retrieved_at: datetime

    def is_active(self, now: datetime) -> bool:
        if self.active_from and now < self.active_from:
            return False
        return not (self.active_to and now > self.active_to)


class AlertSnapshot(BaseModel):
    source: str
    source_timestamp: datetime | None
    retrieved_at: datetime
    alerts: list[ServiceAlert]


# --- EMT -----------------------------------------------------------------------------------


class EmtArrival(BaseModel):
    line: str
    destination: str | None
    seconds: int | None  # None: beyond the API's horizon (sent as 999999)
    vehicle_id: str | None
    distance_m: int | None  # metres along the route to the stop
    # The bus's last GPS fix (`geometry`). EMT updates it mostly at stops (live check of
    # 2026-11-12: 23 of 26 fixes within 60 m of a stop), so it says roughly where the bus
    # last stopped. None when missing or implausible (EMT sometimes sends 0,0).
    lat: float | None = None
    lon: float | None = None


class EmtArrivals(BaseModel):
    stop_code: str
    retrieved_at: datetime
    server_time: datetime | None  # the API's "datetime": when it answered, not an observation
    arrivals: list[EmtArrival]
