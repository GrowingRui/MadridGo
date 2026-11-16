"""An expired timetable kept in use on a current calendar (app/ingest/carry.py): Metro de
Madrid on Metro Ligero's calendar, and how the API labels it."""

import zipfile
from datetime import date
from pathlib import Path

import pytest

from app import stops
from app.feeds import feed_state
from app.ingest.carry import carry_forward
from app.ingest.gtfs import GtfsZip
from app.ingest.sources import GTFS_SOURCES, SOURCES_BY_KEY
from app.journeys import FeedInfo, plan_notices

TODAY = date(2026, 11, 16)
CAL = "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
DATES = "service_id,date,exception_type\n"


def gtfs(path: Path, calendar: str, dates: str = "", trips: str = "") -> Path:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("stops.txt", "stop_id,stop_name\nA,A\n")
        z.writestr("trips.txt", trips or "route_id,service_id,trip_id\nR,S_WD,T1\n")
        z.writestr("calendar.txt", "﻿" + CAL + calendar)  # CRTM files start with a BOM
        if dates:
            z.writestr("calendar_dates.txt", DATES + dates)
    return path


# Metro's last calendar (abridged) and Metro Ligero's current one, as CRTM publishes them.
METRO = (
    "4_I12,0,0,0,0,0,1,0,20250527,20260527\n"
    "4_I13,0,0,0,0,0,0,1,20250527,20260527\n"
    "4_I14,1,1,1,1,0,0,0,20250527,20260527\n"
    "4_I15,0,0,0,0,1,0,0,20250527,20260527\n"
)
METRO_DATES = "4_I14,20251225,2\n4_I13,20251225,1\n"
ML = (
    "10_I13,0,0,0,0,0,0,1,20261028,20271028\n"
    "10_I12,0,0,0,0,0,1,0,20261028,20271028\n"
    "10_I15,0,0,0,0,1,0,0,20261028,20271028\n"
    "10_I14,1,1,1,1,0,0,0,20261028,20271028\n"
)
ML_DATES = "10_I14,20261208,2\n10_I13,20261208,1\n10_I12,20261212,2\n"


@pytest.fixture
def donor(tmp_path: Path) -> Path:
    return gtfs(tmp_path / "ml.zip", ML, ML_DATES)


def table(path: Path, name: str) -> list[dict[str, str]]:
    with GtfsZip(path) as feed:
        return list(feed.rows(name))


def test_expired_calendar_takes_the_dates_and_holidays_of_the_same_day_type(
    tmp_path: Path, donor: Path
) -> None:
    metro = gtfs(tmp_path / "metro.zip", METRO, METRO_DATES)
    carried = carry_forward(metro, donor, TODAY)
    assert carried is not None
    assert carried.original_end == date(2026, 5, 27)
    assert (carried.start, carried.end) == (date(2026, 10, 28), date(2027, 10, 28))
    cal = {r["service_id"]: r for r in table(metro, "calendar")}
    assert set(cal) == {"4_I12", "4_I13", "4_I14", "4_I15"}  # Metro's own service ids
    assert cal["4_I14"]["monday"] == "1" and cal["4_I14"]["friday"] == "0"
    assert {(r["start_date"], r["end_date"]) for r in cal.values()} == {("20261028", "20271028")}
    # Holidays: Mon-Thu off and Sunday service on 8 Dec; old 2025 exceptions gone.
    assert sorted(
        (r["service_id"], r["date"], r["exception_type"]) for r in table(metro, "calendar_dates")
    ) == [("4_I12", "20261212", "2"), ("4_I13", "20261208", "1"), ("4_I14", "20261208", "2")]
    assert table(metro, "trips") == [{"route_id": "R", "service_id": "S_WD", "trip_id": "T1"}]


def test_current_calendar_is_left_alone(tmp_path: Path, donor: Path) -> None:
    fresh = METRO.replace("20260527", "20271231")
    metro = gtfs(tmp_path / "metro.zip", fresh, METRO_DATES)
    before = metro.read_bytes()
    assert carry_forward(metro, donor, TODAY) is None
    assert metro.read_bytes() == before


def test_a_day_type_the_donor_lacks_is_an_error(tmp_path: Path, donor: Path) -> None:
    odd = gtfs(tmp_path / "metro.zip", "X,1,1,1,1,1,1,1,20250101,20260101\n")
    with pytest.raises(ValueError, match="no service of ml.zip matches"):
        carry_forward(odd, donor, TODAY)


def test_metro_borrows_metro_ligeros_calendar_which_is_imported_first() -> None:
    assert SOURCES_BY_KEY["metro"].calendar_from == "ml"
    for src in GTFS_SOURCES:
        if src.calendar_from:
            assert SOURCES_BY_KEY[src.calendar_from].calendar_from is None


def test_feed_state() -> None:
    end, old = date(2027, 10, 28), date(2026, 5, 27)
    assert feed_state(end, None, TODAY, 14)[0] == "ok"
    assert feed_state(end, old, TODAY, 14)[0] == "estimated"
    # Once the borrowed calendar runs out too, it is plainly expired.
    assert feed_state(date(2026, 11, 1), old, TODAY, 14)[0] == "expired"


def test_board_and_journeys_say_the_times_are_estimates() -> None:
    ends: dict[str, date | None] = {"metro": date(2027, 10, 28), "ml": date(2027, 10, 28)}
    carried = {"metro": date(2026, 5, 27)}
    notices = stops._notices(["metro", "ml"], ends, TODAY, carried)
    assert [(n.source, n.expiry) for n in notices] == [("metro", "estimated")]
    assert "estimates" in notices[0].message and "2026-05-27" in notices[0].message

    info = FeedInfo(service_end=ends, route_ids={}, carried_from=carried)
    assert [n.source for n in plan_notices(info, {"metro"}, TODAY)] == ["metro"]
    # Only when a journey actually rides the Metro.
    assert plan_notices(info, {"cercanias"}, TODAY) == []
