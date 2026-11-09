"""Freshness states (RELIABILITY_STRATEGY.md §3). Pure functions; the clock is an argument.

Initial thresholds are proposals. `python -m app.realtime calibrate` measures the real
update interval of each source and suggests new values (FRESH = p95 x 2, DELAYED = p99 x 3).
"""

import logging
from dataclasses import dataclass
from datetime import datetime

from app.realtime.models import AgeBasis, Freshness, FreshnessState

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Thresholds:
    fresh_s: int  # age <= fresh_s: FRESH
    delayed_s: int  # age <= delayed_s: DELAYED_UPDATE; older: STALE
    # A source time further than this in the future is not trusted (clock skew).
    future_tolerance_s: int = 30


THRESHOLDS: dict[str, Thresholds] = {
    "renfe_gtfsrt": Thresholds(fresh_s=60, delayed_s=180),
    "renfe_alerts": Thresholds(fresh_s=300, delayed_s=900),
    "emt_mobilitylabs": Thresholds(fresh_s=60, delayed_s=180),
    "emt_rss": Thresholds(fresh_s=900, delayed_s=3600),
}

UNAVAILABLE = Freshness(state="UNAVAILABLE", age_s=None, age_basis=None)


def assess(
    now: datetime,
    source_timestamp: datetime | None,
    retrieved_at: datetime | None,
    th: Thresholds,
) -> Freshness:
    """Classify data by age. Uses the source's own time when it has one; otherwise the
    retrieval time, flagged as such. Ages are never negative."""
    anomaly = None
    basis: AgeBasis
    if source_timestamp is not None:
        basis, age = "source", (now - source_timestamp).total_seconds()
        if age < -th.future_tolerance_s:
            # The source claims a time in the future: its clock is wrong, so its age means
            # nothing. Fall back to when we fetched it and flag it.
            anomaly = "source_timestamp_in_future"
            log.warning("source timestamp %s is %.0f s ahead", source_timestamp.isoformat(), -age)
            if retrieved_at is not None:
                basis, age = "retrieved", (now - retrieved_at).total_seconds()
    elif retrieved_at is not None:
        basis, age = "retrieved", (now - retrieved_at).total_seconds()
    else:
        return UNAVAILABLE
    age_s = max(0, round(age))
    state: FreshnessState
    if age_s <= th.fresh_s:
        state = "FRESH"
    elif age_s <= th.delayed_s:
        state = "DELAYED_UPDATE"
    else:
        state = "STALE"
    return Freshness(state=state, age_s=age_s, age_basis=basis, anomaly=anomaly)


def is_usable(f: Freshness) -> bool:
    """Only FRESH and DELAYED_UPDATE data may be shown as live."""
    return f.state in ("FRESH", "DELAYED_UPDATE")
