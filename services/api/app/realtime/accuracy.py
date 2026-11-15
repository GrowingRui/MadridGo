"""How accurate are MadridGo's live times? (RELIABILITY_STRATEGY.md §4)

On every Renfe poll the worker stores, for each running train:

1. **Predictions.** The time the app shows for each stop still ahead (the timetable moved
   by the trip's delay, as in `board.renfe_train`), sampled once at each horizon: the first
   poll at which that time was at most 30, 20, 10, 5 or 2 minutes away. A stop after the one
   Renfe names is marked `estimated` ("Live · est." in the app). For the stop Renfe names,
   Renfe's own time is kept too (`source_predicted_at`): it differs from timetable + delay
   in about 40% of updates (trace of 2026-11-14), so we can later see which is better.
2. **Arrivals (ground truth).** Renfe's vehicle positions say `STOPPED_AT <stop>` from the
   moment a train is at a station. The arrival is placed halfway between the last feed
   that did not say so and the first that did (the feed updates every ~20 s), so it is off
   by at most half that gap (`uncertainty_s`). Trace of 2026-11-14: `INCOMING_AT X` ->
   `STOPPED_AT X` lands on the minute Renfe predicted. The feed is noisy (trains jump back
   and forth between two stations, `STOPPED_AT X` -> `IN_TRANSIT_TO X` means it left), so
   only a station further along the trip than the last one seen counts, and the first
   station never does (waiting there is not arriving).

Error = actual - predicted: positive means the train came later than MadridGo said.
Timetable adherence (actual - scheduled) is reported separately and never mixed in.

Everything here is pure except the `Sampler` and the SQL helpers at the bottom.
"""

import logging
from dataclasses import astuple, dataclass, field
from datetime import date, datetime, timedelta

import asyncpg

from app.realtime import renfe
from app.realtime.board import add_seconds, renfe_freshness
from app.realtime.freshness import is_usable
from app.realtime.models import FeedSnapshot
from app.timetable import MADRID, at_service_time

log = logging.getLogger(__name__)

HORIZONS_MIN = (30, 20, 10, 5, 2)
# A sample counts for horizon H while the stop is between H min and H min - this away, so
# one missed poll (30 s) or a delay that grew a little does not lose the sample.
HORIZON_WINDOW_S = 90
# Arrivals are only placed between two feeds this close; otherwise we do not know when.
MAX_FEED_GAP_S = 90
RETENTION_DAYS = 90
# RELIABILITY_STRATEGY.md §4: a figure is final only with this many matched predictions
# per operator and horizon, over at least this many days.
MIN_SAMPLE = 500
MIN_DAYS = 7


@dataclass(frozen=True)
class ScheduledStop:
    index: int
    stop_id: str
    arrival_s: int


@dataclass(frozen=True)
class TripPlan:
    trip_id: str
    line: str | None
    stops: tuple[ScheduledStop, ...]

    def index_of(self, stop_id: str | None, after: int = 0) -> int | None:
        """The first position of `stop_id` past `after` (stop 0 never counts)."""
        if stop_id is None:
            return None
        return next((s.index for s in self.stops if s.index > after and s.stop_id == stop_id), None)


@dataclass(frozen=True)
class Prediction:
    trip_id: str
    service_date: date
    stop_index: int
    stop_id: str
    line: str | None
    horizon_min: int
    made_at: datetime
    source_ts: datetime | None
    scheduled_at: datetime
    predicted_at: datetime
    delay_s: int
    estimated: bool
    source_predicted_at: datetime | None


@dataclass(frozen=True)
class Arrival:
    trip_id: str
    service_date: date
    stop_index: int
    stop_id: str
    line: str | None
    scheduled_at: datetime
    observed_at: datetime
    uncertainty_s: int
    method: str = "renfe_stopped_at"


def service_date(plan: TripPlan, now: datetime, delay_s: int = 0) -> date | None:
    """The service day the trip runs on around `now`: today's, or yesterday's for a train
    still running after midnight (as `trips.estimate`)."""
    if not plan.stops:
        return None
    today = now.astimezone(MADRID).date()
    for day in (today, today - timedelta(days=1)):
        first = at_service_time(day, plan.stops[0].arrival_s)
        last = add_seconds(at_service_time(day, plan.stops[-1].arrival_s), max(delay_s, 0))
        if first - timedelta(hours=3) <= now <= last + timedelta(hours=1):
            return day
    return None


def predictions(snap: FeedSnapshot, plans: dict[str, TripPlan], now: datetime) -> list[Prediction]:
    """The predictions this poll makes at one of the sampled horizons."""
    if not is_usable(renfe_freshness(snap, now)):
        return []  # the app would show the timetable, so there is no prediction to judge
    out: list[Prediction] = []
    made = snap.retrieved_at
    for trip_id, t in snap.trips.items():
        plan = plans.get(trip_id)
        if plan is None or t.cancelled:
            continue
        update_idx = plan.index_of(t.stop_id, after=-1)
        delay = t.delay_s
        day = service_date(plan, now, delay or 0)
        if day is None:
            continue
        if delay is None and update_idx is not None and t.stop_time is not None:
            at_update = at_service_time(day, plan.stops[update_idx].arrival_s)
            delay = round((t.stop_time - at_update).total_seconds())
        if delay is None:
            continue
        for s in plan.stops:
            if s.index == 0:
                continue
            scheduled = at_service_time(day, s.arrival_s)
            if update_idx is not None:
                if s.index < update_idx:
                    continue  # behind the train
            elif t.stop_time is not None and scheduled < t.stop_time - timedelta(seconds=delay):
                continue
            predicted = add_seconds(scheduled, delay)
            lead = (predicted - made).total_seconds()
            for h in HORIZONS_MIN:
                if h * 60 - HORIZON_WINDOW_S < lead <= h * 60:
                    out.append(
                        Prediction(
                            trip_id=trip_id,
                            service_date=day,
                            stop_index=s.index,
                            stop_id=s.stop_id,
                            line=plan.line,
                            horizon_min=h,
                            made_at=made,
                            source_ts=snap.source_timestamp,
                            scheduled_at=scheduled,
                            predicted_at=predicted,
                            delay_s=delay,
                            estimated=s.index != update_idx,
                            source_predicted_at=t.stop_time if s.index == update_idx else None,
                        )
                    )
    return out


@dataclass(frozen=True)
class _Seen:
    feed_ts: datetime
    stopped_at: str | None  # stop id while STOPPED_AT, else None
    last_index: int  # furthest stop this trip was seen arriving at (-1: none yet)


@dataclass
class ArrivalTracker:
    """Remembers each train's last state between polls to spot arrivals."""

    seen: dict[str, _Seen] = field(default_factory=dict)

    def update(
        self, snap: FeedSnapshot, plans: dict[str, TripPlan], now: datetime
    ) -> list[Arrival]:
        ts = snap.source_timestamp or snap.retrieved_at
        out: list[Arrival] = []
        seen: dict[str, _Seen] = {}
        for trip_id, v in snap.vehicles.items():
            prev = self.seen.get(trip_id)
            if prev is not None and prev.feed_ts >= ts:
                seen[trip_id] = prev  # same (or older) feed as last time: nothing new
                continue
            stopped = v.stop_id if v.current_status == "STOPPED_AT" else None
            last_index = prev.last_index if prev else -1
            plan = plans.get(trip_id)
            if (
                plan is not None
                and prev is not None
                and stopped is not None
                and stopped != prev.stopped_at
                and (ts - prev.feed_ts).total_seconds() <= MAX_FEED_GAP_S
            ):
                idx = plan.index_of(stopped, after=max(last_index, 0))
                t = snap.trips.get(trip_id)
                day = service_date(plan, now, (t.delay_s or 0) if t else 0)
                if idx is not None and day is not None:
                    gap = ts - prev.feed_ts
                    out.append(
                        Arrival(
                            trip_id=trip_id,
                            service_date=day,
                            stop_index=idx,
                            stop_id=stopped,
                            line=plan.line,
                            scheduled_at=at_service_time(day, plan.stops[idx].arrival_s),
                            observed_at=prev.feed_ts + gap / 2,
                            uncertainty_s=round(gap.total_seconds() / 2),
                        )
                    )
                    last_index = idx
            seen[trip_id] = _Seen(ts, stopped, last_index)
        self.seen = seen  # trains no longer in the feed are forgotten
        return out


# --- Database ------------------------------------------------------------------------------


async def load_plans(pool: asyncpg.Pool, trip_ids: list[str]) -> dict[str, TripPlan]:
    rows = await pool.fetch(
        """SELECT t.native_id AS trip_id, r.short_name, st.stop_id,
                  coalesce(st.arrival_s, st.departure_s) AS arrival_s
           FROM feed_version fv
           JOIN trip t ON t.feed_version_id = fv.id AND t.native_id = ANY($1::text[])
           JOIN route r ON r.feed_version_id = fv.id AND r.native_id = t.route_id
           JOIN stop_time st ON st.feed_version_id = fv.id AND st.trip_id = t.native_id
           WHERE fv.is_active AND fv.source = 'cercanias'
           ORDER BY t.native_id, st.stop_sequence""",
        trip_ids,
    )
    stops: dict[str, list[ScheduledStop]] = {}
    lines: dict[str, str | None] = {}
    for r in rows:
        if r["arrival_s"] is None:
            continue
        lst = stops.setdefault(r["trip_id"], [])
        lst.append(ScheduledStop(len(lst), r["stop_id"], r["arrival_s"]))
        lines[r["trip_id"]] = r["short_name"]
    return {k: TripPlan(k, lines[k], tuple(v)) for k, v in stops.items()}


# Column order = field order of Prediction / Arrival (stored with astuple).
async def store(pool: asyncpg.Pool, preds: list[Prediction], arrivals: list[Arrival]) -> None:
    if preds:
        await pool.executemany(
            """INSERT INTO prediction_sample (source, trip_id, service_date, stop_index, stop_id,
                   line, horizon_min, made_at, source_ts, scheduled_at, predicted_at, delay_s,
                   estimated, source_predicted_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
               ON CONFLICT DO NOTHING""",
            [(renfe.SOURCE, *astuple(p)) for p in preds],
        )
    if arrivals:
        await pool.executemany(
            """INSERT INTO observed_arrival (source, trip_id, service_date, stop_index, stop_id,
                   line, scheduled_at, observed_at, uncertainty_s, method)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT DO NOTHING""",
            [(renfe.SOURCE, *astuple(a)) for a in arrivals],
        )


@dataclass
class Sampler:
    """Called by the worker after each Renfe poll. Never raises: measuring accuracy must not
    get in the way of serving live data."""

    pool: asyncpg.Pool
    plans: dict[str, TripPlan | None] = field(default_factory=dict)
    tracker: ArrivalTracker = field(default_factory=ArrivalTracker)

    async def record(self, snap: FeedSnapshot, now: datetime) -> tuple[int, int]:
        try:
            missing = [t for t in snap.trips.keys() | snap.vehicles.keys() if t not in self.plans]
            if missing:
                found = await load_plans(self.pool, missing)
                for t in missing:
                    self.plans[t] = found.get(t)  # None: not in the timetable, do not ask again
            plans = {k: v for k, v in self.plans.items() if v is not None}
            preds = predictions(snap, plans, now)
            arrivals = self.tracker.update(snap, plans, now)
            await store(self.pool, preds, arrivals)
            return len(preds), len(arrivals)
        except Exception as exc:  # noqa: BLE001
            log.warning("accuracy sampling failed: %s", type(exc).__name__)
            return 0, 0

    def forget_plans(self) -> None:
        """Called daily, so a new timetable is picked up."""
        self.plans.clear()


# --- Results -------------------------------------------------------------------------------

# The figures come from the SQL function accuracy_metrics(first, last) (migration 0003):
# matched predictions, and arrivals against the timetable, by line and horizon, plus the
# whole operator as line '*'.


async def metrics(pool: asyncpg.Pool, first: date, last: date) -> list[asyncpg.Record]:
    rows: list[asyncpg.Record] = await pool.fetch(
        """SELECT * FROM accuracy_metrics($1, $2)
           ORDER BY line <> '*', line, kind, horizon_min DESC, estimated""",
        first,
        last,
    )
    return rows


async def aggregate_and_prune(pool: asyncpg.Pool, now: datetime) -> None:
    """Keep daily results of finished service days for good, then delete raw rows older than
    the retention period. A service day is finished 4 h after its midnight (night trains)."""
    finished = (now.astimezone(MADRID) - timedelta(hours=4)).date() - timedelta(days=1)
    days = await pool.fetch(
        """SELECT DISTINCT service_date FROM observed_arrival o
           WHERE service_date <= $1 AND NOT EXISTS
               (SELECT 1 FROM accuracy_daily a WHERE a.day = o.service_date)""",
        finished,
    )
    for r in days:
        d = r["service_date"]
        await pool.execute(
            """INSERT INTO accuracy_daily (day, source, line, kind, horizon_min, estimated, n,
                   mae_s, median_abs_s, p90_abs_s, bias_s, pct_1m, pct_2m, pct_5m)
               SELECT $1::date, source, line, kind, horizon_min, estimated, n, mae_s,
                      median_abs_s, p90_abs_s, bias_s, pct_1m, pct_2m, pct_5m
               FROM accuracy_metrics($1, $1)
               ON CONFLICT DO NOTHING""",
            d,
        )
    cutoff = now - timedelta(days=RETENTION_DAYS)
    await pool.execute("DELETE FROM prediction_sample WHERE made_at < $1", cutoff)
    await pool.execute("DELETE FROM observed_arrival WHERE observed_at < $1", cutoff)
