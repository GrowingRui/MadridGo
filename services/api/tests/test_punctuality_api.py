"""`GET /punctuality`: how late each Cercanías line usually is. No docker needed."""

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.disruptions import LineLookup, get_line_lookup
from app.main import app
from app.realtime.usual import ALL, MIN_DAYS, Figure, UsualDelays, get_usual_delays
from app.stops import Line


class FakeLookup(LineLookup):
    def __init__(self) -> None:
        pass

    async def lines(self, feed: str, ids: set[str], by: str) -> list[Line]:  # type: ignore[override]
        assert feed == "cercanias" and by == "name"
        known = {"C4A": ("C4a", "2C4A9C")}
        return [
            Line(
                source=feed,
                route_id=f"{n}-{d}",
                short_name=known[n][0],
                long_name=None,
                mode="rail",
                color=known[n][1],
                text_color="FFFFFF",
            )
            for n in sorted(ids)
            if n in known
            for d in (1, 2)
        ]


def fig(line: str, stop: str, band: str, median_min: float, often_min: float) -> Figure:
    return Figure(line, stop, band, 120, 8, median_min * 60, often_min * 60)


@pytest.fixture
def use_figures() -> Iterator[Any]:
    def install(figs: list[Figure]) -> None:
        delays = UsualDelays.of(figs)

        async def get() -> UsualDelays:
            return delays

        app.dependency_overrides[get_usual_delays] = get
        app.dependency_overrides[get_line_lookup] = FakeLookup

    yield install
    app.dependency_overrides.clear()


def test_lines_with_overall_and_bands(use_figures: Any) -> None:
    use_figures(
        [
            fig("C4a", ALL, ALL, 5.2, 11.0),
            fig("C4a", ALL, "weekday_morning", 7.0, 14.0),
            fig("C4a", ALL, "weekend", 1.0, 3.0),
            fig("C4a", "18000", ALL, 9.0, 15.0),  # a station's figure is not the line's
            fig("C10", ALL, ALL, 3.4, 8.0),
            fig("C2", ALL, "weekday_night", 2.0, 4.0),  # a band without an overall figure
        ]
    )
    res = TestClient(app).get("/punctuality")
    assert res.status_code == 200
    body = res.json()
    assert body["available"] is True and body["min_days"] == MIN_DAYS
    assert res.headers["cache-control"] == "public, max-age=600"
    # Sorted as in the timetable (C2, C4a, C10); C2 and C10 are unknown there: no colour.
    assert [lp["line"]["short_name"] for lp in body["lines"]] == ["C2", "C4a", "C10"]
    c4a = body["lines"][1]
    assert c4a["line"]["color"] == "2C4A9C"
    assert c4a["overall"] == {"minutes": 5, "often_minutes": 11, "sample": 120, "days": 8}
    assert set(c4a["bands"]) == {"weekday_morning", "weekend"}
    assert c4a["bands"]["weekday_morning"]["minutes"] == 7
    c2 = body["lines"][0]
    assert c2["overall"] is None and set(c2["bands"]) == {"weekday_night"}


def test_nothing_before_enough_data(use_figures: Any) -> None:
    use_figures([])
    body = TestClient(app).get("/punctuality").json()
    assert body["available"] is False and body["lines"] == []
