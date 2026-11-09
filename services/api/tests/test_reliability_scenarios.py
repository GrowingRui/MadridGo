"""Reliability scenarios R1-R9 and R13-R15 (docs/RELIABILITY_TEST_PLAN.md §4).

Journey-level parts are in tests/test_journeys.py (Phase 4): R1 transfer labels, R2 flagged
journeys, R6 routing blocked on expired feeds and R10 missed transfers. R11-R12 (re-planning)
are Phase 6. Here R1 covers the departure time and delay.
"""

import asyncio
import time
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app import stops
from app.feeds import expiry_state
from app.ingest.sources import SOURCES_BY_KEY
from app.realtime import board
from app.realtime.cache import MemoryKV, emt_arrivals_key, put_model
from app.realtime.emt import (
    EmtArrivalsService,
    EmtClient,
    EmtError,
    parse_arrivals,
)
from app.realtime.models import EmtArrivals
from app.realtime.resilience import (
    CircuitBreaker,
    CircuitOpen,
    RateLimited,
    RetryPolicy,
    Upstream,
    UpstreamFailed,
)
from app.timetable import MADRID, at_service_time, seconds_into
from tests.realtime_helpers import (
    CountingTransport,
    FakeClock,
    departure,
    realtime_with,
    snapshot,
)

NOW = datetime(2026, 11, 10, 8, 0, tzinfo=MADRID)
TRIP = "1012L99999C4a"


def overlay(  # type: ignore[no-untyped-def]
    snap_header: datetime | None,
    trips: list[dict[str, object]],
    deps: list[stops.Departure],
    retrieved: datetime | None = None,
    now: datetime = NOW,
):
    snap = None
    if snap_header is not None:
        snap = snapshot(snap_header, retrieved or snap_header, trips)
    return asyncio.run(stops._overlay_renfe(realtime_with(snap), deps, now))


# --- R1 Delayed train (+7 min) ---------------------------------------------------------------


def test_r1_delay_at_the_reported_stop() -> None:
    sched = NOW + timedelta(minutes=10)
    deps, status = overlay(
        NOW - timedelta(seconds=15),
        [{"trip_id": TRIP, "stop_id": "18000", "time": sched + timedelta(minutes=7), "delay": 420}],
        [departure(TRIP, sched)],
    )
    d = deps[0]
    assert d.status == "live" and d.realtime is not None
    assert d.realtime.predicted_time == sched + timedelta(minutes=7)  # exact, ±0 s
    assert d.realtime.delay_s == 420
    assert d.realtime.estimated_from_trip_delay is False
    assert d.time == sched  # the scheduled time is kept, not overwritten
    assert d.realtime.source == "renfe_gtfsrt" and d.realtime.retrieved_at is not None
    assert status.status == "live"


def test_r1_delay_carried_to_a_later_stop_is_marked_estimated() -> None:
    update_sched = NOW + timedelta(minutes=5)  # the train's next stop, 17000
    board_sched = NOW + timedelta(minutes=10)
    deps, _ = overlay(
        NOW,
        [
            {
                "trip_id": TRIP,
                "stop_id": "17000",
                "time": update_sched + timedelta(minutes=7),
                "delay": 420,
            }
        ],
        [departure(TRIP, board_sched)],
    )
    assert deps[0].realtime is not None
    assert deps[0].realtime.predicted_time == board_sched + timedelta(minutes=7)
    assert deps[0].realtime.estimated_from_trip_delay is True


def test_train_already_beyond_this_stop_is_removed() -> None:
    deps, _ = overlay(
        NOW,
        [{"trip_id": TRIP, "stop_id": "17000", "time": NOW + timedelta(minutes=22), "delay": 420}],
        [departure(TRIP, NOW + timedelta(minutes=10))],  # 17000 is scheduled at 08:15
    )
    assert deps == []


def test_early_train_negative_delay() -> None:
    sched = NOW + timedelta(minutes=10)
    deps, _ = overlay(
        NOW,
        [{"trip_id": TRIP, "stop_id": "18000", "time": sched - timedelta(minutes=1), "delay": -60}],
        [departure(TRIP, sched)],
    )
    assert deps[0].realtime is not None and deps[0].realtime.delay_s == -60


# --- R2 Cancelled trip -----------------------------------------------------------------------


def test_r2_cancelled_trip() -> None:
    deps, _ = overlay(
        NOW, [{"trip_id": TRIP, "cancelled": True}], [departure(TRIP, NOW + timedelta(minutes=10))]
    )
    assert deps[0].status == "cancelled"
    assert deps[0].realtime is not None and deps[0].realtime.classification == "CANCELLED"
    assert deps[0].realtime.predicted_time is None


# --- R3 Missing update for a trip --------------------------------------------------------------


def test_r3_trip_without_update_stays_scheduled() -> None:
    deps, status = overlay(
        NOW,
        [{"trip_id": "1012LOTHERC4a", "stop_id": "18000", "time": NOW, "delay": 0}],
        [departure(TRIP, NOW + timedelta(minutes=10))],
    )
    assert deps[0].status == "scheduled" and deps[0].realtime is None
    assert status.status == "live"  # the feed itself is fine


# --- R4 Stale observations --------------------------------------------------------------------


def test_r4_stale_feed_is_never_live() -> None:
    old = NOW - timedelta(minutes=10)
    sched = NOW + timedelta(minutes=10)
    deps, status = overlay(
        old,
        [{"trip_id": TRIP, "stop_id": "18000", "time": sched + timedelta(minutes=7), "delay": 420}],
        [departure(TRIP, sched)],
    )
    assert deps[0].status == "scheduled" and deps[0].realtime is None
    assert status.status == "stale"
    assert "outdated" in status.message.lower() and "10 min" in status.message


def test_delayed_update_is_still_live_but_says_so() -> None:
    sched = NOW + timedelta(minutes=10)
    deps, status = overlay(
        NOW - timedelta(minutes=2),
        [{"trip_id": TRIP, "stop_id": "18000", "time": sched, "delay": 0}],
        [departure(TRIP, sched)],
    )
    assert deps[0].status == "live"
    assert status.status == "delayed_update" and "2 min ago" in status.message


def test_no_snapshot_means_unavailable_and_scheduled() -> None:
    deps, status = overlay(None, [], [departure(TRIP, NOW + timedelta(minutes=10))])
    assert deps[0].status == "scheduled"
    assert status.status == "unavailable"


# --- R5 Source timestamp in the future ----------------------------------------------------------


def test_r5_future_source_timestamp_is_flagged_and_age_never_negative() -> None:
    sched = NOW + timedelta(minutes=10)
    deps, status = overlay(
        NOW + timedelta(hours=1),  # header claims a time an hour ahead
        [{"trip_id": TRIP, "stop_id": "18000", "time": sched, "delay": 0}],
        [departure(TRIP, sched)],
        retrieved=NOW - timedelta(seconds=5),
    )
    assert status.freshness is not None
    assert status.freshness.anomaly == "source_timestamp_in_future"
    assert status.freshness.age_basis == "retrieved"
    assert status.freshness.age_s == 5
    assert deps[0].status == "live"  # judged by when we fetched it, which is recent


def test_r5_future_timestamp_with_old_retrieval_is_stale() -> None:
    _, status = overlay(NOW + timedelta(hours=1), [], [], retrieved=NOW - timedelta(minutes=30))
    assert status.status == "stale"


# --- R6 Expired timetable -------------------------------------------------------------------------


def test_r6_expired_feed_produces_a_notice() -> None:
    today = NOW.date()
    state, days = expiry_state(today - timedelta(days=167), today, 14)
    assert state == "expired" and days < 0
    notices = stops._notices(["metro"], {"metro": today - timedelta(days=167)}, today)
    assert notices[0].expiry == "expired"
    assert "No scheduled times" in notices[0].message
    # Routing on expired feeds is blocked by /journeys: tests/test_journeys.py (R6).


# --- R7 Timeout --------------------------------------------------------------------------------


def _upstream(transport: httpx.MockTransport, clock: FakeClock, **kw: object) -> Upstream:
    return Upstream(
        name="test",
        client=httpx.AsyncClient(transport=transport),
        sleep=clock.sleep,
        clock=clock,
        wallclock=clock.wall,
        rng=lambda: 0.0,
        **kw,  # type: ignore[arg-type]
    )


def test_r7_timeouts_are_retried_twice_then_fail() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    clock, transport = FakeClock(), CountingTransport(handler)
    up = _upstream(transport, clock)
    with pytest.raises(UpstreamFailed):
        asyncio.run(up.request("GET", "https://x.test/", deadline_s=6))
    assert len(transport.calls) == 3
    assert clock.slept == [0.5, 1.5]
    assert up.stats.retries == 2 and up.stats.last_error == "timeout"


def test_r7_overall_deadline_bounds_a_hanging_upstream() -> None:
    async def hang(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(30)
        return httpx.Response(200)

    up = Upstream(name="hang", client=httpx.AsyncClient(transport=httpx.MockTransport(hang)))
    started = time.perf_counter()
    with pytest.raises(UpstreamFailed):
        asyncio.run(up.request("GET", "https://x.test/", deadline_s=0.3))
    assert time.perf_counter() - started < 2


def test_r7_server_errors_are_retried_but_client_errors_are_not() -> None:
    codes = iter([503, 502, 200])
    clock = FakeClock()
    t = CountingTransport(lambda r: httpx.Response(next(codes)))
    assert asyncio.run(_upstream(t, clock).request("GET", "https://x.test/")).status_code == 200
    assert len(t.calls) == 3

    t404 = CountingTransport(lambda r: httpx.Response(404))
    assert asyncio.run(_upstream(t404, clock).request("GET", "https://x.test/")).status_code == 404
    assert len(t404.calls) == 1


def _emt_data(retrieved: datetime) -> EmtArrivals:
    body = {
        "code": "00",
        "datetime": "2026-11-10T08:00:00",
        "data": [
            {
                "Arrive": [
                    {
                        "line": "27",
                        "destination": "PLAZA CASTILLA",
                        "bus": 540,
                        "estimateArrive": 600,
                        "DistanceBus": 1000,
                    }
                ]
            }
        ],
    }
    return parse_arrivals("62", body, retrieved)


def test_r7_emt_failure_serves_cache_with_its_true_age() -> None:
    now = datetime(2026, 11, 10, 7, 0, tzinfo=UTC)
    kv = MemoryKV()
    cached = _emt_data(now - timedelta(seconds=90))
    asyncio.run(put_model(kv, emt_arrivals_key("62"), cached, 900))

    async def failing(stop: str) -> EmtArrivals:
        raise UpstreamFailed("emt: timeout")

    svc = EmtArrivalsService(kv=kv, fetch=failing, wallclock=lambda: now)
    got = asyncio.run(svc.get("62"))
    assert got.error == "failed" and got.data == cached
    f = board.emt_freshness(got.data, now)
    assert (f.state, f.age_s, f.age_basis) == ("DELAYED_UPDATE", 90, "retrieved")


def test_r7_emt_failure_without_cache_is_unavailable() -> None:
    async def failing(stop: str) -> EmtArrivals:
        raise UpstreamFailed("emt: timeout")

    got = asyncio.run(EmtArrivalsService(kv=MemoryKV(), fetch=failing).get("62"))
    assert got.data is None
    assert board.emt_freshness(None, NOW).state == "UNAVAILABLE"


def test_emt_cache_is_shared_and_requests_are_coalesced() -> None:
    calls = 0

    async def slow(stop: str) -> EmtArrivals:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return _emt_data(datetime.now(UTC))

    async def scenario() -> None:
        svc = EmtArrivalsService(kv=MemoryKV(), fetch=slow)
        results = await asyncio.gather(*(svc.get("62") for _ in range(10)))
        assert all(r.data is not None for r in results)
        await svc.get("62")  # within the 20 s reuse window: no new call

    asyncio.run(scenario())
    assert calls == 1


# --- R8 HTTP 429 -------------------------------------------------------------------------------


@pytest.mark.parametrize("retry_after", ["120", "Tue, 10 Nov 2026 08:02:00 GMT"])
def test_r8_rate_limit_is_honoured(retry_after: str) -> None:
    clock = FakeClock()
    clock.wall = lambda: datetime(2026, 11, 10, 8, 0, tzinfo=UTC)  # type: ignore[method-assign]
    t = CountingTransport(lambda r: httpx.Response(429, headers={"Retry-After": retry_after}))
    up = _upstream(t, clock)
    with pytest.raises(RateLimited) as exc:
        asyncio.run(up.request("GET", "https://x.test/"))
    assert exc.value.retry_after_s == 120
    clock.now += 119
    with pytest.raises(RateLimited):
        asyncio.run(up.request("GET", "https://x.test/"))
    assert len(t.calls) == 1  # no extra upstream call while backing off
    assert up.breaker.state == "closed"  # being throttled is not being broken
    clock.now += 2
    with pytest.raises(RateLimited):
        asyncio.run(up.request("GET", "https://x.test/"))
    assert len(t.calls) == 2


# --- R9 Circuit breaker ---------------------------------------------------------------------------


def test_r9_breaker_opens_after_five_failures_and_probes_after_30_s() -> None:
    clock = FakeClock()
    healthy = False
    t = CountingTransport(lambda r: httpx.Response(200 if healthy else 500))
    up = _upstream(t, clock, policy=RetryPolicy(max_retries=0), breaker=CircuitBreaker(clock=clock))
    for _ in range(5):
        with pytest.raises(UpstreamFailed):
            asyncio.run(up.request("GET", "https://x.test/"))
    assert up.breaker.state == "open" and len(t.calls) == 5

    clock.now += 29
    with pytest.raises(CircuitOpen):
        asyncio.run(up.request("GET", "https://x.test/"))
    assert len(t.calls) == 5  # no upstream call while open

    clock.now += 1  # 30 s: one probe goes through, and fails: open again
    with pytest.raises(UpstreamFailed):
        asyncio.run(up.request("GET", "https://x.test/"))
    assert up.breaker.state == "open" and len(t.calls) == 6

    clock.now += 30
    healthy = True
    assert asyncio.run(up.request("GET", "https://x.test/")).status_code == 200
    assert up.breaker.state == "closed" and up.breaker.openings == 2


def test_r9_breaker_opens_on_failure_rate() -> None:
    clock = FakeClock()
    br = CircuitBreaker(clock=clock)
    for ok in [False, True, False, True, False, False, True, False, True, False]:
        assert br.allow()
        br.success() if ok else br.failure()
        clock.now += 1
    assert br.state == "open"  # 6 of 10 failed in 60 s, never more than 2 in a row


def test_r9_emt_refused_login_opens_the_breaker() -> None:
    """A 403 is a valid HTTP answer, but it must still count as a failure."""
    clock = FakeClock()
    t = CountingTransport(lambda r: httpx.Response(403, json={"code": "84", "data": []}))
    up = _upstream(t, clock, breaker=CircuitBreaker(clock=clock))
    client = EmtClient(upstream=up, client_id="id", pass_key="key", wallclock=clock.wall)
    for _ in range(5):
        with pytest.raises(EmtError):
            asyncio.run(client.arrivals("62"))
    with pytest.raises(CircuitOpen):
        asyncio.run(client.arrivals("62"))
    assert len(t.calls) == 5


def test_emt_token_is_reused_and_refreshed_when_rejected() -> None:
    clock = FakeClock()
    logins = arrivals = 0
    reject_next = False

    def handler(r: httpx.Request) -> httpx.Response:
        nonlocal logins, arrivals, reject_next
        if "login" in r.url.path:
            logins += 1
            assert r.headers["X-ClientId"] == "id" and r.headers["passKey"] == "key"
            return httpx.Response(
                200,
                json={
                    "code": "01",
                    "data": [{"accessToken": f"tok{logins}", "tokenSecExpiration": 86400}],
                },
            )
        arrivals += 1
        if reject_next:
            reject_next = False
            return httpx.Response(200, json={"code": "80", "description": "Token not found"})
        assert r.headers["accessToken"] == f"tok{logins}"
        return httpx.Response(200, json={"code": "00", "data": [{"Arrive": []}]})

    up = _upstream(CountingTransport(handler), clock)
    client = EmtClient(upstream=up, client_id="id", pass_key="key", wallclock=clock.wall)
    asyncio.run(client.arrivals("62"))
    asyncio.run(client.arrivals("62"))
    assert (logins, arrivals) == (1, 2)
    reject_next = True
    asyncio.run(client.arrivals("62"))
    assert (logins, arrivals) == (2, 4)
    assert up.breaker.state == "closed" and up.stats.failures == 0


# --- R13 Frequency-based legs ---------------------------------------------------------------------


def test_r13_frequency_services_carry_no_exact_time() -> None:
    assert "time" not in stops.FrequencyService.model_fields
    assert {"headway_min", "from_time", "until_time"} <= set(stops.FrequencyService.model_fields)


# --- R14 DST nights ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("day", "expected_offset_h"),
    [(datetime(2026, 10, 25).date(), 1), (datetime(2027, 3, 28).date(), 2)],
)
def test_r14_scheduled_times_on_dst_days(day, expected_offset_h) -> None:  # type: ignore[no-untyped-def]
    t = at_service_time(day, 8 * 3600)
    assert (t.hour, t.minute) == (8, 0)
    assert t.utcoffset() == timedelta(hours=expected_offset_h)
    assert seconds_into(day, t) == 8 * 3600


def test_r14_live_delay_across_the_autumn_change_is_absolute() -> None:
    # 02:55 CEST + 10 min = 02:05 CET (the clocks went back at 03:00 CEST).
    sched = datetime(2026, 10, 25, 0, 55, tzinfo=UTC).astimezone(MADRID)
    assert (sched.hour, sched.minute, sched.utcoffset()) == (2, 55, timedelta(hours=2))
    predicted = board.add_seconds(sched, 600)
    # (Subtracting two Madrid-zoned datetimes compares wall clocks, so compare in UTC.)
    assert predicted.astimezone(UTC) - sched.astimezone(UTC) == timedelta(minutes=10)
    assert (predicted.hour, predicted.minute, predicted.utcoffset()) == (2, 5, timedelta(hours=1))


def test_r14_live_delay_across_the_spring_change_is_absolute() -> None:
    # 01:55 CET + 10 min = 03:05 CEST (02:00-03:00 does not exist).
    sched = datetime(2027, 3, 28, 1, 55, tzinfo=MADRID)
    predicted = board.add_seconds(sched, 600)
    assert (predicted.hour, predicted.minute) == (3, 5)
    assert predicted.astimezone(UTC) - sched.astimezone(UTC) == timedelta(minutes=10)


# --- R15 Interurban stop 8_16825 -----------------------------------------------------------------


@pytest.mark.parametrize("feed", ["interurban", "urban", "metro", "ml"])
def test_r15_operators_without_authorized_realtime(feed: str) -> None:
    st = board.no_realtime_status(feed, SOURCES_BY_KEY[feed].operator_name)
    assert st.status == "not_available" and st.source is None
    assert "timetable" in st.message
    if feed in ("interurban", "urban"):
        assert "not available for this line in MadridGo" in st.message


def test_r15_renfe_data_never_touches_bus_departures() -> None:
    bus = stops.Line(
        source="interurban",
        route_id="8__469___",
        short_name="469",
        long_name=None,
        mode="bus",
        color=None,
        text_color=None,
    )
    dep = departure("8__469___1", NOW + timedelta(minutes=10), stop="crtm:par_8_16825", line=bus)
    deps, _ = overlay(
        NOW, [{"trip_id": "8__469___1", "stop_id": "par_8_16825", "time": NOW, "delay": 300}], [dep]
    )
    assert deps[0].status == "scheduled" and deps[0].realtime is None
