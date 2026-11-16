"""How late trains usually are (app/realtime/usual.py). Pure logic, no docker needed."""

from datetime import date, datetime, timedelta

from app.realtime.usual import (
    ALL,
    MIN_DAYS,
    MIN_LEVEL_DAYS,
    MIN_N,
    Figure,
    Observation,
    UsualDelays,
    band_of,
    figures,
)
from app.stops import Departure, Line, _with_usual
from app.timetable import MADRID

MONDAY = date(2026, 11, 16)


def t(day: date, h: int, m: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, h, m, tzinfo=MADRID)


def obs(
    late_min: float, *, day: date = MONDAY, h: int = 8, stop: str = "18000", line: str = "C4a"
) -> Observation:
    return Observation(line, stop, day, t(day, h), late_min * 60)


def weekdays(n: int) -> list[date]:
    out, d = [], MONDAY
    while len(out) < n:
        if d.isoweekday() < 6:
            out.append(d)
        d += timedelta(days=1)
    return out


def spread(late_min: float, days: list[date], per_day: int, **kw: object) -> list[Observation]:
    return [obs(late_min, day=d, **kw) for d in days for _ in range(per_day)]  # type: ignore[arg-type]


def test_bands_follow_the_week() -> None:
    assert band_of(t(MONDAY, 7, 30)) == "weekday_morning"
    assert band_of(t(MONDAY, 12)) == "weekday_midday"
    assert band_of(t(MONDAY, 18)) == "weekday_evening"
    assert band_of(t(MONDAY, 22)) == "weekday_night"
    assert band_of(t(MONDAY, 5, 59)) == "weekday_night"
    assert band_of(t(date(2026, 11, 21), 8)) == "weekend"  # Saturday


def test_nothing_before_a_week_of_data() -> None:
    six = [MONDAY + timedelta(days=i) for i in range(MIN_DAYS - 1)]
    assert figures(spread(4, six, 100)) == []


def test_levels_from_station_and_time_to_whole_line() -> None:
    days = weekdays(MIN_DAYS + 3)
    figs = {(f.stop_id, f.band): f for f in figures(spread(4, days, 10))}
    assert set(figs) == {
        ("18000", "weekday_morning"),
        ("18000", ALL),
        (ALL, "weekday_morning"),
        (ALL, ALL),
    }
    f = figs[("18000", "weekday_morning")]
    assert (f.n, f.days, f.median_s) == (100, 10, 240)


def test_a_level_needs_enough_trains_on_enough_days() -> None:
    days = weekdays(MIN_DAYS + 3)
    base = spread(3, days, 10)  # plenty at Atocha (18000)
    # Sol: enough trains but only on MIN_LEVEL_DAYS - 1 days; Nuevos Ministerios: too few.
    sol = spread(9, days[: MIN_LEVEL_DAYS - 1], MIN_N, stop="18001")
    nm = spread(9, days, 1, stop="17000")[: MIN_N - 1]
    stops = {f.stop_id for f in figures(base + sol + nm)}
    assert stops == {"18000", ALL}


def test_median_ignores_one_very_late_train_and_counts_early_as_on_time() -> None:
    days = weekdays(MIN_DAYS)
    late = [-2.0] * 31 + [1.0] * 29 + [60.0]  # early, on time, one an hour late
    o = [obs(m, day=days[i % len(days)]) for i, m in enumerate(late)]
    f = next(f for f in figures(o) if f.stop_id == ALL and f.band == ALL)
    assert f.median_s == 0  # early counts as 0, so most trains were "on time"
    assert f.often_s == 60  # 80% within a minute


def fig(stop: str, band: str, median_min: float) -> Figure:
    return Figure("C4a", stop, band, 50, 7, median_min * 60, (median_min + 3) * 60)


def test_lookup_prefers_the_most_detailed_figure() -> None:
    u = UsualDelays.of(
        [
            fig("18000", "weekday_morning", 5),
            fig("18000", ALL, 3),
            fig(ALL, "weekday_morning", 2.4),
            fig(ALL, ALL, 1),
        ]
    )
    at8, at12 = t(MONDAY, 8), t(MONDAY, 12)
    assert u.lookup("C4a", "18000", at8).scope == "stop_time"  # type: ignore[union-attr]
    assert u.lookup("C4a", "18000", at8).minutes == 5  # type: ignore[union-attr]
    assert u.lookup("C4a", "18000", at12).scope == "stop"  # type: ignore[union-attr]
    other = u.lookup("C4a", "99999", at8)
    assert other is not None and (other.scope, other.minutes) == ("line_time", 2)
    assert u.lookup("C4a", None, at12).scope == "line"  # type: ignore[union-attr]
    assert u.lookup("C5", "18000", at8) is None
    assert UsualDelays().lookup("C4a", "18000", at8) is None


def _row(status: str, source: str = "cercanias") -> Departure:

    line = Line(
        source=source,
        route_id="r",
        short_name="C4a",
        long_name=None,
        mode="rail",
        color=None,
        text_color=None,
    )
    return Departure(
        time=t(MONDAY, 8),
        line=line,
        headsign=None,
        stop_id=f"{source}:18000",
        trip_id="x",
        wheelchair_accessible=None,
        status=status,  # type: ignore[arg-type]
    )


def test_board_rows_without_a_live_time_get_the_usual_delay() -> None:

    u = UsualDelays.of([fig("18000", "weekday_morning", 5)])
    assert _with_usual(_row("scheduled"), u).usual_delay.minutes == 5  # type: ignore[union-attr]
    assert _with_usual(_row("live"), u).usual_delay is None
    assert _with_usual(_row("cancelled"), u).usual_delay is None
    assert _with_usual(_row("scheduled", "metro"), u).usual_delay is None
