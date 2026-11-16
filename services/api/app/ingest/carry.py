"""Keep using a timetable whose calendar has run out (Metro de Madrid: CRTM's last file ends
2026-05-27 and CRTM can't publish a new one, reply of 2026-11-16).

The trips, times and frequencies stay as they are; only the calendar is replaced by the one
of a current feed from the same publisher with the same day types (Metro Ligero: Monday to
Thursday, Friday, Saturday, Sunday, and the same public holidays). Each service takes the
dates and holiday exceptions of the current service that runs on the same weekdays. The
result is an estimate, and the app labels it so (feed_version.carried_from).
"""

import csv
import io
import shutil
import zipfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from app.ingest.gtfs import GtfsZip, parse_date

_DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_CALENDAR_COLS = ["service_id", *_DAYS, "start_date", "end_date"]
_DATES_COLS = ["service_id", "date", "exception_type"]


@dataclass(frozen=True)
class Carried:
    original_end: date  # last day of the feed's own calendar
    start: date
    end: date
    services: int
    exceptions: int


def calendar_end(feed: GtfsZip) -> date | None:
    """Last day any service of the feed runs, from calendar and calendar_dates."""
    ends = [parse_date(r["end_date"]) for r in feed.rows("calendar") if r.get("end_date")]
    ends += [
        parse_date(r["date"]) for r in feed.rows("calendar_dates") if r.get("exception_type") == "1"
    ]
    return max(ends, default=None)


def _pattern(row: dict[str, str]) -> tuple[str, ...]:
    return tuple(row.get(d, "0") for d in _DAYS)


def carry_forward(path: Path, donor: Path, today: date) -> Carried | None:
    """If the feed at `path` has no service left from `today` on, rewrite its calendar in
    place with the calendar of `donor` (see module docstring). Returns None if the feed is
    still current. Raises ValueError if a service has no weekday match in the donor."""
    with GtfsZip(path) as feed:
        original_end = calendar_end(feed)
        if original_end is not None and original_end >= today:
            return None
        if original_end is None:
            raise ValueError(f"{path.name}: no calendar to carry forward")
        if feed.prefix:
            raise ValueError(f"{path.name}: expected a flattened feed")
        services = list(feed.rows("calendar"))

    with GtfsZip(donor) as d:
        by_pattern: dict[tuple[str, ...], dict[str, str]] = {}
        for r in d.rows("calendar"):
            by_pattern.setdefault(_pattern(r), r)
        donor_dates = list(d.rows("calendar_dates"))

    calendar: list[dict[str, str]] = []
    dates: list[dict[str, str]] = []
    for s in services:
        match = by_pattern.get(_pattern(s))
        if match is None:
            raise ValueError(
                f"{path.name}: service {s['service_id']} runs on days {_pattern(s)}, "
                f"which no service of {donor.name} matches"
            )
        calendar.append({**s, "start_date": match["start_date"], "end_date": match["end_date"]})
        dates += [
            {**r, "service_id": s["service_id"]}
            for r in donor_dates
            if r["service_id"] == match["service_id"]
        ]
    if not calendar:
        raise ValueError(f"{path.name}: no calendar.txt services to carry forward")

    tmp = path.with_suffix(".carry.zip")
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            if info.filename in ("calendar.txt", "calendar_dates.txt"):
                continue
            with zin.open(info) as src, zout.open(info.filename, "w") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
        zout.writestr("calendar.txt", _csv(_CALENDAR_COLS, calendar))
        zout.writestr("calendar_dates.txt", _csv(_DATES_COLS, dates))
    tmp.replace(path)
    return Carried(
        original_end=original_end,
        start=min(parse_date(c["start_date"]) for c in calendar),
        end=max(parse_date(c["end_date"]) for c in calendar),
        services=len(calendar),
        exceptions=len(dates),
    )


def _csv(columns: list[str], rows: list[dict[str, str]]) -> str:
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
    w.writeheader()
    w.writerows(rows)
    return out.getvalue()
