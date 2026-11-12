import zipfile
from datetime import date, datetime
from pathlib import Path

import pytest

from app.feeds import expiry_state
from app.ingest.__main__ import flatten
from app.ingest.gtfs import GtfsZip, color, fold, parse_time
from app.ingest.subset import subset, tidy_name
from app.ingest.validate import summarise_report
from app.timetable import (
    MADRID,
    at_service_time,
    display_name,
    line_sort_key,
    mode_for,
    seconds_into,
)
from tests import gtfs_fixture


@pytest.mark.parametrize(
    ("value", "expected"),
    [("08:00:00", 28800), ("7:00:00", 25200), ("25:30:00", 91800), ("", None)],
)
def test_parse_time(value: str, expected: int | None) -> None:
    assert parse_time(value) == expected


def test_fold_removes_accents_and_case() -> None:
    assert fold("  Chamartín  -  CLARA  ") == "chamartin - clara"
    assert fold("Ñ") == "n"


def test_color() -> None:
    assert color("#ff0000") == "FF0000"
    assert color("") is None
    assert color("zzz") is None


def test_gtfs_zip_finds_files_in_subfolder(tmp_path: Path) -> None:
    path = gtfs_fixture.build(tmp_path / "f.zip")
    with GtfsZip(path) as feed:
        assert feed.prefix == "google_transit_X/"
        assert feed.has("frequencies")
        assert not feed.has("shapes")
        assert [r["stop_id"] for r in feed.rows("stops")][:2] == ["est_99_1", "par_99_1"]
        assert list(feed.rows("shapes")) == []


def test_flatten_moves_files_to_root(tmp_path: Path) -> None:
    src = gtfs_fixture.build(tmp_path / "nested.zip")
    out = flatten(src, tmp_path / "flat.zip")
    with zipfile.ZipFile(out) as z:
        assert "stops.txt" in z.namelist()
        assert not any("/" in n for n in z.namelist())


def test_not_a_gtfs_zip(tmp_path: Path) -> None:
    p = tmp_path / "x.zip"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("readme.txt", "hi")
    with pytest.raises(ValueError, match="not a GTFS"):
        GtfsZip(p)


def test_service_time_handles_dst_end() -> None:
    # 2026-10-25: clocks go back 03:00 -> 02:00. GTFS counts from noon minus 12 h,
    # so 08:00:00 is still 08:00 local time.
    t = at_service_time(date(2026, 10, 25), 8 * 3600)
    assert (t.hour, t.minute) == (8, 0)
    assert seconds_into(date(2026, 10, 25), t) == 8 * 3600


def test_service_time_after_midnight() -> None:
    t = at_service_time(date(2026, 11, 9), 25 * 3600 + 30 * 60)
    assert t == datetime(2026, 11, 10, 1, 30, tzinfo=MADRID)


@pytest.mark.parametrize(
    ("raw", "nice"),
    [
        ("AV.LEGUARIO-LUIS CHAMIZO", "Av. Leguario - Luis Chamizo"),
        ("ESTACIÓN DE ATOCHA", "Estación de Atocha"),
        ("Madrid-Atocha Cercanías", "Madrid - Atocha Cercanías"),
        ("Plaza Castilla", "Plaza Castilla"),
        ("AV.JUAN PABLO II-ANTONIO GAUDÍ", "Av. Juan Pablo II - Antonio Gaudí"),
        ("GABRIEL GªMÁRQUEZ", "Gabriel Gª Márquez"),
        ("Pº.ANDES-ALAMEDA BAJA", "Pº. Andes - Alameda Baja"),
        ("CALLE VI", "Calle VI"),
    ],
)
def test_display_name(raw: str, nice: str) -> None:
    assert display_name(raw) == nice


def test_line_sort_is_natural() -> None:
    assert sorted(["C10", "C2", "C1", "N1", "3", "27"], key=line_sort_key) == [
        "3", "27", "C1", "C2", "C10", "N1"
    ]  # fmt: skip


def test_mode_for() -> None:
    assert [mode_for(t) for t in (0, 1, 2, 3, 109, 700)] == [
        "light_rail", "metro", "rail", "bus", "rail", "bus"
    ]  # fmt: skip


@pytest.mark.parametrize(
    ("end", "state", "days"),
    [
        (date(2026, 5, 27), "expired", -166),
        (date(2026, 11, 16), "expiring", 7),
        (date(2026, 12, 31), "ok", 52),
        (None, "expired", 0),
    ],
)
def test_expiry_state(end: date | None, state: str, days: int) -> None:
    assert expiry_state(end, date(2026, 11, 9), warning_days=7) == (state, days)


def test_summarise_validator_report(tmp_path: Path) -> None:
    report = {
        "notices": [
            {"code": "a_error", "severity": "ERROR", "totalNotices": 3},
            {"code": "b_error", "severity": "ERROR", "totalNotices": 10},
            {"code": "w", "severity": "WARNING", "totalNotices": 5},
            {"code": "i", "severity": "INFO", "totalNotices": 99},
        ]
    }
    s = summarise_report(report, tmp_path)
    assert (s.status, s.errors, s.warnings) == ("errors", 13, 5)
    assert s.top_errors == ["b_error x10", "a_error x3"]
    assert summarise_report({"notices": []}, tmp_path).status == "valid"


def test_subset_keeps_one_network(tmp_path: Path) -> None:
    # Renfe-style padding in headers and values must be trimmed.
    padded_routes = (
        "route_id  ,agency_id,route_short_name,route_long_name   ,route_type,route_color\n"
        "T1   ,A,T1,Testville - Norte        ,2,ff0000\n"
        "F2,A,F2,Prueba - Norte,3,00AA00\n"
    )
    src = gtfs_fixture.build(tmp_path / "all.zip", overrides={"routes.txt": padded_routes})
    counts = subset(src, tmp_path / "t.zip", "T")
    assert counts["routes"] == 1
    assert counts["trips"] == 2
    assert counts["stop_times"] == 4
    assert "frequencies" not in counts or counts["frequencies"] == 0
    with GtfsZip(tmp_path / "t.zip") as feed:
        assert feed.prefix == ""
        assert [r["route_long_name"] for r in feed.rows("routes")] == ["Testville - Norte"]
        assert {r["stop_id"] for r in feed.rows("stops")} == {"par_99_1", "par_99_3"}
        assert [r["service_id"] for r in feed.rows("calendar")] == ["ALL"]
        assert len(list(feed.rows("feed_info"))) == 2
        assert [r["agency_id"] for r in feed.rows("agency")] == ["A"]  # routes name no agency


def test_tidy_name_removes_renfe_padding() -> None:
    assert tidy_name("Colmenar Viejo" + " " * 26 + "-Parla") == "Colmenar Viejo - Parla"
    assert tidy_name("Aeropuerto-T4" + " " * 27 + "-Principe Pio") == "Aeropuerto-T4 - Principe Pio"
    assert tidy_name("Chamartín - Clara Campoamor") == "Chamartín - Clara Campoamor"
    assert tidy_name(" C4b ") == "C4b"


def test_subset_moves_stops_the_feed_puts_in_the_wrong_place(tmp_path: Path) -> None:
    src = gtfs_fixture.build(tmp_path / "all.zip")
    subset(src, tmp_path / "t.zip", "T", (("par_99_3", 40.3819607, -3.6245835),))
    with GtfsZip(tmp_path / "t.zip") as feed:
        stops = {r["stop_id"]: r for r in feed.rows("stops")}
    assert (stops["par_99_3"]["stop_lat"], stops["par_99_3"]["stop_lon"]) == (
        "40.3819607",
        "-3.6245835",
    )
    assert stops["par_99_1"]["stop_lat"] != "40.3819607"  # others untouched
