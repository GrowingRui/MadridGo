"""Prediction-accuracy sampling (app/realtime/accuracy.py): which predictions are kept at
which horizon, and when a train counts as having arrived. Pure logic, no docker needed."""

from datetime import UTC, date, datetime, timedelta

from app.realtime.accuracy import (
    ArrivalTracker,
    ScheduledStop,
    TripPlan,
    predictions,
    service_date,
)
from app.realtime.models import FeedSnapshot, TripRealtime, VehicleRealtime
from app.timetable import MADRID, at_service_time

DAY = date(2026, 11, 14)
TRIP = "1017S27284C4a"


def hm(h: int, m: int, s: int = 0) -> int:
    return h * 3600 + m * 60 + s


# A, B, C, D at 10:00, 10:10, 10:25, 10:40 (Madrid).
PLAN = TripPlan(
    TRIP,
    "C4a",
    tuple(
        ScheduledStop(i, stop, hm(10, m))
        for i, (stop, m) in enumerate([("A", 0), ("B", 10), ("C", 25), ("D", 40)])
    ),
)
PLANS = {TRIP: PLAN}


def at(h: int, m: int, s: int = 0) -> datetime:
    return datetime(2026, 11, 14, h, m, s, tzinfo=MADRID).astimezone(UTC)


def snap(
    now: datetime,
    *,
    delay: int | None = 0,
    next_stop: str | None = "B",
    stop_time: datetime | None = None,
    cancelled: bool = False,
    feed_ts: datetime | None = None,
    vehicle: tuple[str, str] | None = None,
) -> FeedSnapshot:
    ts = feed_ts or now - timedelta(seconds=5)
    trips = {
        TRIP: TripRealtime(
            trip_id=TRIP,
            entity_id=TRIP,
            cancelled=cancelled,
            delay_s=delay,
            stop_id=next_stop,
            stop_time=stop_time,
        )
    }
    vehicles = {}
    if vehicle is not None:
        status, stop = vehicle
        vehicles[TRIP] = VehicleRealtime(
            trip_id=TRIP,
            vehicle_id="v1",
            label=None,
            platform=None,
            lat=None,
            lon=None,
            current_status=status,
            stop_id=stop,
            timestamp=ts,
        )
    return FeedSnapshot(
        source="renfe_gtfsrt",
        source_timestamp=ts,
        retrieved_at=now,
        trips=trips,
        vehicles=vehicles,
    )


# --- Predictions ---------------------------------------------------------------------------


def test_keeps_each_stop_ahead_at_the_horizon_it_has_reached() -> None:
    now = at(10, 5)
    preds = predictions(snap(now, stop_time=at(10, 10)), PLANS, now)
    got = {(p.stop_id, p.horizon_min, p.estimated) for p in preds}
    # B is 5 min away (the stop Renfe names), C 20 min (carried-forward delay), D 35 min.
    assert got == {("B", 5, False), ("C", 20, True)}
    b = next(p for p in preds if p.stop_id == "B")
    assert b.service_date == DAY
    assert b.scheduled_at == at(10, 10) and b.predicted_at == at(10, 10)
    assert b.source_predicted_at == at(10, 10)
    c = next(p for p in preds if p.stop_id == "C")
    assert c.source_predicted_at is None
    assert c.line == "C4a"


def test_prediction_is_timetable_plus_delay_as_the_app_shows_it() -> None:
    now = at(10, 6)
    # 1 min late; Renfe's own time for B says 10:12, the app shows 10:11.
    preds = predictions(snap(now, delay=60, stop_time=at(10, 12)), PLANS, now)
    b = next(p for p in preds if p.stop_id == "B")
    assert b.horizon_min == 5
    assert b.predicted_at == at(10, 11)
    assert b.source_predicted_at == at(10, 12)
    assert b.delay_s == 60


def test_horizon_window_tolerates_a_missed_poll_but_not_more() -> None:
    # B at 10:10: 5-min sample from 10:05:00 down to 10:06:30.
    def at_b(now: datetime) -> list[int]:
        return [p.horizon_min for p in predictions(snap(now), PLANS, now) if p.stop_id == "B"]

    assert at_b(at(10, 6, 20)) == [5]
    assert at_b(at(10, 6, 40)) == []


def test_stops_behind_the_train_and_the_first_stop_are_never_sampled() -> None:
    now = at(10, 21)
    preds = predictions(snap(now, next_stop="C"), PLANS, now)
    assert {p.stop_id for p in preds} == {"C", "D"}  # 4 and 19 min away; B is behind
    # Before departure, the first stop is not an arrival.
    now = at(9, 58)
    assert all(p.stop_index > 0 for p in predictions(snap(now, next_stop="A"), PLANS, now))


def test_no_prediction_for_cancelled_trains_stale_feeds_or_unknown_delay() -> None:
    now = at(10, 5)
    assert predictions(snap(now, cancelled=True), PLANS, now) == []
    stale = snap(now, feed_ts=now - timedelta(minutes=10))
    assert predictions(stale, PLANS, now) == []
    assert predictions(snap(now, delay=None), PLANS, now) == []
    assert predictions(snap(now), {}, now) == []


def test_delay_taken_from_renfe_time_when_the_trip_has_none() -> None:
    now = at(10, 7)
    preds = predictions(snap(now, delay=None, stop_time=at(10, 12)), PLANS, now)
    b = next(p for p in preds if p.stop_id == "B")
    assert b.delay_s == 120 and b.predicted_at == at(10, 12)


def test_service_date_of_a_train_running_after_midnight() -> None:
    night = TripPlan(
        "n", None, (ScheduledStop(0, "A", hm(23, 50)), ScheduledStop(1, "B", hm(24, 20)))
    )
    after_midnight = datetime(2026, 11, 15, 0, 10, tzinfo=MADRID)
    assert service_date(night, after_midnight) == DAY
    assert at_service_time(DAY, hm(24, 20)) == datetime(2026, 11, 15, 0, 20, tzinfo=MADRID)
    assert service_date(PLAN, datetime(2026, 11, 14, 10, 30, tzinfo=MADRID)) == DAY
    # Not running around then: hours before it starts or after it ends.
    assert service_date(PLAN, datetime(2026, 11, 14, 5, 0, tzinfo=MADRID)) is None
    assert service_date(PLAN, datetime(2026, 11, 14, 22, 0, tzinfo=MADRID)) is None


# --- Arrivals ------------------------------------------------------------------------------


def feed(tracker: ArrivalTracker, feed_ts: datetime, status: str, stop: str):  # type: ignore[no-untyped-def]
    now = feed_ts + timedelta(seconds=10)
    return tracker.update(snap(now, feed_ts=feed_ts, vehicle=(status, stop)), PLANS, now)


def test_arrival_is_halfway_between_the_last_feed_before_and_the_first_at_the_stop() -> None:
    tr = ArrivalTracker()
    assert feed(tr, at(10, 9, 40), "INCOMING_AT", "B") == []
    [a] = feed(tr, at(10, 10, 0), "STOPPED_AT", "B")
    assert a.stop_id == "B" and a.stop_index == 1 and a.service_date == DAY
    assert a.observed_at == at(10, 9, 50)
    assert a.uncertainty_s == 10
    assert a.scheduled_at == at(10, 10)
    assert a.line == "C4a"


def test_noise_after_an_arrival_is_ignored() -> None:
    tr = ArrivalTracker()
    feed(tr, at(10, 9, 40), "INCOMING_AT", "B")
    assert len(feed(tr, at(10, 10, 0), "STOPPED_AT", "B")) == 1
    # Renfe: STOPPED_AT B -> IN_TRANSIT_TO B means it left; B again is not a new arrival.
    assert feed(tr, at(10, 10, 20), "IN_TRANSIT_TO", "B") == []
    assert feed(tr, at(10, 10, 40), "STOPPED_AT", "B") == []
    # Jumping back to an earlier station is noise too.
    assert feed(tr, at(10, 11, 0), "IN_TRANSIT_TO", "C") == []
    assert feed(tr, at(10, 11, 20), "STOPPED_AT", "A") == []
    # The next station counts.
    feed(tr, at(10, 24, 40), "INCOMING_AT", "C")
    [c] = feed(tr, at(10, 25, 0), "STOPPED_AT", "C")
    assert c.stop_index == 2


def test_no_arrival_without_a_feed_just_before() -> None:
    tr = ArrivalTracker()
    # Already standing there when first seen: when it arrived is unknown.
    assert feed(tr, at(10, 10), "STOPPED_AT", "B") == []
    # A gap of more than 90 s between feeds: too uncertain.
    tr = ArrivalTracker()
    feed(tr, at(10, 8), "INCOMING_AT", "B")
    assert feed(tr, at(10, 10), "STOPPED_AT", "B") == []


def test_same_feed_polled_twice_does_not_move_the_arrival() -> None:
    tr = ArrivalTracker()
    feed(tr, at(10, 9, 40), "INCOMING_AT", "B")
    feed(tr, at(10, 9, 40), "INCOMING_AT", "B")  # the feed had not changed
    [a] = feed(tr, at(10, 10, 0), "STOPPED_AT", "B")
    assert a.observed_at == at(10, 9, 50)


def test_waiting_at_the_first_station_is_not_an_arrival() -> None:
    tr = ArrivalTracker()
    feed(tr, at(9, 59, 0), "IN_TRANSIT_TO", "A")
    assert feed(tr, at(9, 59, 20), "STOPPED_AT", "A") == []


def test_trains_without_a_timetable_are_tracked_but_not_reported() -> None:
    tr = ArrivalTracker()
    now = at(10, 10, 10)
    s1 = snap(now - timedelta(seconds=20), feed_ts=at(10, 9, 40), vehicle=("INCOMING_AT", "B"))
    s2 = snap(now, feed_ts=at(10, 10, 0), vehicle=("STOPPED_AT", "B"))
    assert tr.update(s1, {}, now) == [] and tr.update(s2, {}, now) == []
