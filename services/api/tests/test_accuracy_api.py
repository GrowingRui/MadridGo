"""`GET /accuracy`: the accuracy report over HTTP (RELIABILITY_STRATEGY.md §4). No docker
needed: the database is faked; the SQL itself is covered in test_realtime_integration.py."""

from collections.abc import Iterator
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.dbpool import get_pool
from app.disruptions import LineLookup, get_line_lookup
from app.main import app
from app.realtime import api as realtime_api
from app.stops import Line


def row(line: str, kind: str, horizon: int, estimated: bool, n: int) -> dict[str, Any]:
    return {
        "source": "renfe_gtfsrt",
        "line": line,
        "kind": kind,
        "horizon_min": horizon,
        "estimated": estimated,
        "n": n,
        "mae_s": 90.54321,
        "median_abs_s": 60.0,
        "p90_abs_s": 240.0,
        "bias_s": 45.0,
        "pct_1m": 0.5,
        "pct_2m": 0.75,
        "pct_5m": 0.95,
    }


class FakePool:
    def __init__(self, rows: list[dict[str, Any]], span: int) -> None:
        self.rows = rows
        self.span = span
        self.calls: list[tuple[date, date]] = []

    async def fetch(self, _sql: str, first: date, last: date) -> list[dict[str, Any]]:
        self.calls.append((first, last))
        return self.rows

    async def fetchval(self, _sql: str, _first: date, _last: date) -> int:
        return self.span


class FakeLookup(LineLookup):
    def __init__(self) -> None:
        pass

    async def lines(self, feed: str, ids: set[str], by: str) -> list[Line]:  # type: ignore[override]
        assert feed == "cercanias" and by == "name"
        # As the real lookup: names asked in upper case, answered as in the timetable.
        # C10 and C2 are not in this timetable: no colour.
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
            for d in (1, 2)  # one route per direction
        ]


@pytest.fixture
def use_pool() -> Iterator[Any]:
    def install(pool: FakePool) -> None:
        app.dependency_overrides[get_pool] = lambda: pool
        app.dependency_overrides[get_line_lookup] = FakeLookup

    realtime_api._accuracy_cache.clear()
    yield install
    app.dependency_overrides.clear()
    realtime_api._accuracy_cache.clear()


FULL = [
    row("*", "prediction", 10, False, 800),
    row("*", "prediction", 10, True, 900),
    row("*", "schedule", 0, False, 1200),
    row("C4a", "prediction", 10, False, 120),
    row("C10", "prediction", 10, False, 30),
    row("C2", "prediction", 10, False, 40),
]


def test_report_shape(use_pool: Any) -> None:
    pool = FakePool(FULL, span=8)
    use_pool(pool)
    res = TestClient(app).get("/accuracy", params={"days": 7})
    assert res.status_code == 200
    body = res.json()
    first, last = pool.calls[0]
    assert (last - first).days == 6
    assert body["first_day"] == first.isoformat() and body["last_day"] == last.isoformat()
    assert body["operator"] == "RENFE_CERCANIAS"
    assert body["days"] == 7 and body["days_with_data"] == 8
    assert body["provisional"] is False
    assert [r["line"] for r in body["rows"]] == ["*", "*", "*", "C4a", "C10", "C2"]
    assert [(ln["short_name"], ln["color"]) for ln in body["lines"]] == [
        ("C2", None),
        ("C4a", "2C4A9C"),
        ("C10", None),
    ]
    timetable = body["rows"][2]
    assert timetable["kind"] == "schedule" and timetable["horizon_min"] is None
    assert body["rows"][0]["horizon_min"] == 10 and body["rows"][0]["pct_1m"] == 0.5
    assert body["rows"][0]["mae_s"] == 90.5
    assert "max-age=300" in res.headers["cache-control"]


@pytest.mark.parametrize(
    ("rows", "span"),
    [
        (FULL, 3),  # too few days
        ([row("*", "prediction", 10, False, 499), *FULL[1:]], 8),  # too few predictions
        ([], 0),  # nothing yet
    ],
)
def test_provisional(use_pool: Any, rows: list[dict[str, Any]], span: int) -> None:
    use_pool(FakePool(rows, span))
    assert TestClient(app).get("/accuracy").json()["provisional"] is True


def test_answer_is_cached_per_period(use_pool: Any) -> None:
    pool = FakePool(FULL, span=8)
    use_pool(pool)
    client = TestClient(app)
    client.get("/accuracy", params={"days": 7})
    client.get("/accuracy", params={"days": 7})
    assert len(pool.calls) == 1
    client.get("/accuracy", params={"days": 30})
    assert len(pool.calls) == 2
    assert (pool.calls[1][1] - pool.calls[1][0]).days == 29


@pytest.mark.parametrize("days", [0, 91, "x"])
def test_bad_period(use_pool: Any, days: object) -> None:
    use_pool(FakePool(FULL, span=8))
    assert TestClient(app).get("/accuracy", params={"days": days}).status_code == 422
