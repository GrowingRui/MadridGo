"""Parsers (against recorded real feeds), freshness, provenance rules and the CRTM gate."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.realtime import board, emt, renfe
from app.realtime.freshness import THRESHOLDS, Thresholds, assess
from app.realtime.models import Freshness, RealtimeInfo
from app.realtime.service import crtm_realtime_enabled
from app.timetable import MADRID
from tests.realtime_helpers import FIXTURES

NOW = datetime(2026, 11, 9, 18, 0, tzinfo=UTC)
TH = Thresholds(fresh_s=60, delayed_s=180)

# --- Freshness -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("age_s", "state"),
    [(0, "FRESH"), (60, "FRESH"), (61, "DELAYED_UPDATE"), (180, "DELAYED_UPDATE"), (181, "STALE")],
)
def test_freshness_boundaries(age_s: int, state: str) -> None:
    f = assess(NOW, NOW - timedelta(seconds=age_s), NOW, TH)
    assert (f.state, f.age_s, f.age_basis) == (state, age_s, "source")


def test_missing_source_time_falls_back_to_retrieval_with_flag() -> None:
    f = assess(NOW, None, NOW - timedelta(seconds=30), TH)
    assert (f.state, f.age_s, f.age_basis) == ("FRESH", 30, "retrieved")


def test_no_data_is_unavailable() -> None:
    assert assess(NOW, None, None, TH).state == "UNAVAILABLE"


def test_small_clock_skew_is_clamped_to_zero() -> None:
    f = assess(NOW, NOW + timedelta(seconds=10), NOW, TH)
    assert (f.age_s, f.anomaly) == (0, None)


# --- Provenance ------------------------------------------------------------------------------


def test_live_value_requires_source_and_retrieval_time() -> None:
    fresh = Freshness(state="FRESH", age_s=1, age_basis="source")
    complete = {
        "classification": "LIVE",
        "source": "renfe_gtfsrt",
        "retrieved_at": NOW,
        "source_timestamp": None,
        "freshness": fresh,
    }
    assert RealtimeInfo.model_validate(complete).source == "renfe_gtfsrt"
    for missing in ("source", "retrieved_at"):
        with pytest.raises(ValidationError):
            RealtimeInfo.model_validate({k: v for k, v in complete.items() if k != missing})
    # A scheduled time can never be dressed up as live information.
    with pytest.raises(ValidationError):
        RealtimeInfo.model_validate({**complete, "classification": "SCHEDULED"})


@pytest.mark.parametrize("ref", ["", "   ", "CRTM-2026-001"])
def test_crtm_realtime_cannot_be_enabled_by_configuration(
    ref: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No adapter exists yet, so no environment can switch CRTM real-time on (ADR 002).
    monkeypatch.setenv("CRTM_AUTHORIZATION_REF", ref)
    settings = Settings()
    assert settings.crtm_authorization_ref == ref
    assert not crtm_realtime_enabled(settings)


# --- Renfe parsing (recorded feeds, 2026-11-09) ----------------------------------------------


def test_renfe_trip_updates_fixture() -> None:
    snap = renfe.parse_trip_updates((FIXTURES / "renfe_trip_updates.pb").read_bytes(), NOW)
    assert snap.source_timestamp == datetime.fromtimestamp(1794246905, UTC)
    assert len(snap.trips) == 77
    assert all(t.trip_id.startswith("10") for t in snap.trips.values())
    cancelled = [t for t in snap.trips.values() if t.cancelled]
    assert len(cancelled) == 3
    running = [t for t in snap.trips.values() if not t.cancelled]
    assert all(t.delay_s is not None and t.stop_id and t.stop_time for t in running)
    t = snap.trips["1012L75628C2"]
    assert (t.delay_s, t.stop_id) == (1200, "70104")


def test_renfe_non_madrid_trips_are_dropped() -> None:
    from tests.realtime_helpers import tu_feed

    data = tu_feed(
        NOW,
        [
            {"trip_id": "1012L1C1", "stop_id": "18000", "time": NOW, "delay": 0},
            {"trip_id": "5112L1C1", "stop_id": "51003", "time": NOW, "delay": 0},  # Sevilla
        ],
    )
    assert list(renfe.parse_trip_updates(data, NOW).trips) == ["1012L1C1"]


def test_renfe_vehicle_positions_fixture() -> None:
    ts, vehicles = renfe.parse_vehicle_positions(
        (FIXTURES / "renfe_vehicle_positions.pb").read_bytes()
    )
    assert ts is not None and len(vehicles) == 74
    v = vehicles["1012L19900C1"]
    assert (v.vehicle_id, v.current_status, v.stop_id) == ("19900", "IN_TRANSIT_TO", "98304")
    assert v.timestamp is not None


def test_renfe_platform_from_label() -> None:
    from google.transit import gtfs_realtime_pb2 as rt

    m = rt.FeedMessage()
    m.header.gtfs_realtime_version = "2.0"
    e = m.entity.add()
    e.id = "VP"
    e.vehicle.trip.trip_id = "1012L23547C1"
    e.vehicle.vehicle.label = "C1-23547-PLATF.(3)"
    _, vehicles = renfe.parse_vehicle_positions(m.SerializeToString())
    assert vehicles["1012L23547C1"].platform == "3"


def test_renfe_alerts_fixture_keeps_madrid_only() -> None:
    snap = renfe.parse_alerts((FIXTURES / "renfe_alerts.pb").read_bytes(), NOW, {"18000", "35002"})
    ids = {a.source_alert_id for a in snap.alerts}
    assert {"INFO_524808", "INFO_525077", "AVISO_524867"} <= ids
    assert "INFO_520876" not in ids  # stop 18002 is not in the Madrid set given
    strike = next(a for a in snap.alerts if a.source_alert_id == "AVISO_524867")
    assert strike.description and "huelga" in strike.description
    assert strike.active_to is None  # open-ended


def test_alerts_for_stop_by_station_and_line() -> None:
    snap = renfe.parse_alerts((FIXTURES / "renfe_alerts.pb").read_bytes(), NOW, {"18000"})
    now = datetime.fromtimestamp(1794246907, UTC)
    found = board.alerts_for_stop([snap], {"cercanias": {"C4a"}}, {"cercanias": {"18000"}}, now)
    ids = [a.source_alert_id for a in found]
    assert ids[0] == "INFO_524808"  # the station-specific alert comes first
    assert "AVISO_524867" not in ids  # starts on 11 November: not active yet
    assert "AVISO_525210" not in ids  # C3 only
    assert board.renfe_line_of("10T0013C4a") == "C4a"


# --- EMT -------------------------------------------------------------------------------------


def test_emt_arrivals_parse() -> None:
    body = json.loads((FIXTURES / "emt_arrivals.json").read_text(encoding="utf-8"))
    data = emt.parse_arrivals("62", body, NOW)
    assert [(a.line, a.seconds) for a in data.arrivals] == [("45", 71), ("27", 280), ("N26", None)]
    assert data.arrivals[2].vehicle_id is None
    assert data.server_time == datetime(2026, 11, 9, 19, 7, 44, 352933, tzinfo=MADRID)


def test_emt_error_code_is_not_data() -> None:
    with pytest.raises(emt.EmtError):
        emt.parse_arrivals("62", {"code": "90", "description": "bad stop", "data": []}, NOW)


def test_emt_live_uses_retrieval_time_and_drops_old_predictions() -> None:
    body = json.loads((FIXTURES / "emt_arrivals.json").read_text(encoding="utf-8"))
    data = emt.parse_arrivals("62", body, NOW)
    later = NOW + timedelta(seconds=120)  # served from cache 2 min later
    f = board.emt_freshness(data, later)
    assert (f.state, f.age_basis) == ("DELAYED_UPDATE", "retrieved")
    live = board.emt_live(data, f, later)
    # Line 45 (71 s) passed more than 30 s ago; 27 and the beyond-horizon N26 remain.
    assert [(a.line, when is None) for a, when, _ in live] == [("27", False), ("N26", True)]
    assert all(info.source_timestamp is None for _, _, info in live)


def test_emt_rss_fixture() -> None:
    snap = emt.parse_rss((FIXTURES / "emt_rss.xml").read_bytes(), NOW)
    assert len(snap.alerts) == 6
    first = snap.alerts[0]
    assert first.route_ids == ["6", "59", "78", "85", "148"]
    assert first.active_from == datetime(2026, 11, 12, 8, 0, tzinfo=MADRID)
    assert first.header and first.header.startswith("Recuperación de Parada")
    assert first.description and "<" not in first.description


def test_thresholds_cover_every_live_source() -> None:
    assert {renfe.SOURCE, emt.SOURCE} <= set(THRESHOLDS)
