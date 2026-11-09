"""Builders for real-time tests: synthetic GTFS-RT feeds, fake clocks and HTTP transports."""

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import httpx
from google.transit import gtfs_realtime_pb2 as rt

from app.realtime.cache import RENFE_SNAPSHOT, MemoryKV, put_model
from app.realtime.models import FeedSnapshot
from app.realtime.renfe import parse_trip_updates
from app.realtime.service import Realtime
from app.stops import Departure, Line

FIXTURES = Path(__file__).parent / "fixtures" / "realtime"


def tu_feed(header: datetime, trips: list[dict[str, object]]) -> bytes:
    """trips: {"trip_id", "cancelled"?, "stop_id"?, "time"?: datetime, "delay"?: int}"""
    m = rt.FeedMessage()
    m.header.gtfs_realtime_version = "2.0"
    m.header.timestamp = int(header.timestamp())
    for t in trips:
        e = m.entity.add()
        e.id = f"TUUPDATE_{t['trip_id']}"
        tu = e.trip_update
        tu.trip.trip_id = str(t["trip_id"])
        if t.get("cancelled"):
            tu.trip.schedule_relationship = rt.TripDescriptor.ScheduleRelationship.Value("CANCELED")
            continue
        stu = tu.stop_time_update.add()
        stu.stop_id = str(t["stop_id"])
        when = t["time"]
        assert isinstance(when, datetime)
        stu.arrival.time = int(when.timestamp())
        if "delay" in t:
            delay = t["delay"]
            assert isinstance(delay, int)
            stu.arrival.delay = delay
            tu.delay = delay
    return m.SerializeToString()


def snapshot(header: datetime, retrieved: datetime, trips: list[dict[str, object]]) -> FeedSnapshot:
    return parse_trip_updates(tu_feed(header, trips), retrieved)


def realtime_with(snap: FeedSnapshot | None) -> Realtime:
    kv = MemoryKV()
    if snap is not None:
        asyncio.run(put_model(kv, RENFE_SNAPSHOT, snap, 900))
    return Realtime(kv=kv, emt_service=None)


C4A = Line(
    source="cercanias",
    route_id="10T0013C4a",
    short_name="C4a",
    long_name=None,
    mode="rail",
    color="2C2A86",
    text_color="FFFFFF",
)


def departure(trip_id: str, at: datetime, stop: str = "renfe:18000", line: Line = C4A) -> Departure:
    return Departure(
        time=at,
        line=line,
        headsign="Parla",
        stop_id=stop,
        trip_id=trip_id,
        wheelchair_accessible=None,
    )


class FakeClock:
    """A monotonic clock that only moves when told to (or when the code under test sleeps)."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds

    def wall(self) -> datetime:
        return datetime.fromtimestamp(1_794_300_000 + self.now, UTC)


Handler = Callable[[httpx.Request], httpx.Response]


class CountingTransport(httpx.MockTransport):
    def __init__(self, handler: Handler) -> None:
        self.calls: list[httpx.Request] = []

        def wrapped(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            return handler(request)

        super().__init__(wrapped)
