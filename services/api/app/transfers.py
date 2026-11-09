"""Transfer reliability labels (RELIABILITY_STRATEGY.md §5). Pure functions, no I/O.

    margin = next departure (best estimate)
             - (arrival (best estimate) + walk time + minimum change time + allowance)

| Label        | Rule                                                                       |
|--------------|----------------------------------------------------------------------------|
| comfortable  | margin >= 5 min                                                            |
| tight        | 2 <= margin < 5 min                                                        |
| at_risk      | 0 <= margin < 2 min (also when a live delay brings it there)               |
| not_feasible | margin < 0, or either vehicle is cancelled                                 |
| uncertain    | the arriving leg has no live data and its arrival time is not known well   |
|              | enough to judge (frequency-based service, or a mode without an allowance)  |

A change onto a frequency-based service (EMT, Metro) is not a fixed connection: it has no
label and is shown as "wait up to N min" (N = headway).

No percentages: there is no validated delay model yet (Phase 6+).
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

TransferLabel = Literal["comfortable", "tight", "at_risk", "not_feasible", "uncertain"]

COMFORTABLE_S = 5 * 60
TIGHT_S = 2 * 60

# Extra time allowed for an arriving vehicle that has no live data, by mode. Initial
# proposals (RELIABILITY_STRATEGY.md §5: "buses use +2 min until data shows otherwise").
# To be replaced by measured delay distributions in Phase 6. A mode missing here gives
# "uncertain".
SCHEDULED_ARRIVAL_ALLOWANCE_S: dict[str, int] = {
    "rail": 60,
    "metro": 60,
    "light_rail": 60,
    "bus": 120,
}

# Curated minimum change times, keyed by (station or stop id, arriving mode, departing
# mode). Starts empty (§5): OTP's walking time covers the path; entries are added only
# after verification on site.
MIN_CHANGE_S: dict[tuple[str, str, str], int] = {}

# Worst first, for a journey's overall label.
SEVERITY: dict[TransferLabel, int] = {
    "not_feasible": 4,
    "at_risk": 3,
    "uncertain": 2,
    "tight": 1,
    "comfortable": 0,
}


@dataclass(frozen=True)
class TransferSide:
    mode: str
    time: datetime  # best estimate: live when usable, else scheduled
    live: bool
    cancelled: bool = False
    frequency_headway_min: int | None = None  # set for headway-based services
    stop_id: str | None = None


@dataclass(frozen=True)
class TransferAssessment:
    label: TransferLabel | None  # None: onto a frequency-based service (wait up to N min)
    margin_s: int | None
    wait_up_to_min: int | None
    message: str


def label_for_margin(margin_s: int) -> TransferLabel:
    if margin_s < 0:
        return "not_feasible"
    if margin_s < TIGHT_S:
        return "at_risk"
    if margin_s < COMFORTABLE_S:
        return "tight"
    return "comfortable"


def _minutes(seconds: int) -> int:
    return seconds // 60 if seconds >= 0 else -((-seconds) // 60)


def assess(arriving: TransferSide, departing: TransferSide, walk_s: int) -> TransferAssessment:
    if arriving.cancelled:
        return TransferAssessment("not_feasible", None, None, "The arriving trip is cancelled.")
    if departing.cancelled:
        return TransferAssessment("not_feasible", None, None, "The connecting trip is cancelled.")

    min_change = MIN_CHANGE_S.get((departing.stop_id or "", arriving.mode, departing.mode), 0)
    allowance = 0 if arriving.live else SCHEDULED_ARRIVAL_ALLOWANCE_S.get(arriving.mode)
    raw_margin = round((departing.time - arriving.time).total_seconds()) - walk_s - min_change

    if departing.frequency_headway_min is not None:
        # Missing one vehicle means waiting for the next, so this is never "not feasible".
        n = departing.frequency_headway_min
        return TransferAssessment(
            None, None, n, f"Frequent service: wait up to {n} min for the next one."
        )

    if allowance is None or (not arriving.live and arriving.frequency_headway_min is not None):
        # Headway-based arrivals have no reliable arrival time: the vehicle could be any one
        # of several, so the margin is unknown.
        label: TransferLabel = "not_feasible" if raw_margin < 0 else "uncertain"
        msg = (
            "The connection leaves before you arrive."
            if raw_margin < 0
            else "Arrival time not known precisely; this change may be tight."
        )
        return TransferAssessment(label, raw_margin, None, msg)

    margin = raw_margin - allowance
    label = label_for_margin(margin)
    basis = "live times" if arriving.live else "the timetable"
    if label == "not_feasible":
        msg = "Not enough time to change"
        if arriving.live:
            msg += ": the arriving vehicle is running late."
        else:
            msg += "."
    else:
        mins = _minutes(margin)
        msg = f"{mins} min to spare after walking, based on {basis}."
    return TransferAssessment(label, margin, None, msg)


def worst(labels: list[TransferLabel | None]) -> TransferLabel | None:
    present: list[TransferLabel] = [lb for lb in labels if lb is not None]
    if not present:
        return None
    return max(present, key=SEVERITY.__getitem__)
