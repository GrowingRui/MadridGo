import asyncio
import logging

import pytest
from fastapi.testclient import TestClient

from app.accesslog import logger
from app.config import Settings, get_settings
from app.health import CheckResult, run_checks
from app.main import create_app


def test_access_log_has_path_status_and_time_but_no_query_or_address() -> None:
    records: list[logging.LogRecord] = []

    class Grab(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    grab = Grab()
    logger.addHandler(grab)
    try:
        # A path that needs no database: the middleware logs 404s the same way.
        TestClient(create_app()).get("/no-such-path?lat=40.4201&lon=-3.7012")
    finally:
        logger.removeHandler(grab)
    text = " ".join(r.getMessage() for r in records)
    assert "GET /no-such-path 404 " in text
    assert "40.4201" not in text and "-3.7012" not in text and "lat=" not in text
    assert "testclient" not in text and "127.0.0.1" not in text
    assert text.rstrip().endswith("ms")


@pytest.fixture
def production(monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    monkeypatch.setenv("MADRIDGO_ENVIRONMENT", "production")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_docs_are_served_in_development() -> None:
    client = TestClient(create_app())
    assert client.get("/openapi.json").status_code == 200
    assert client.get("/docs").status_code == 200


def test_docs_are_not_served_in_production(production: None) -> None:
    client = TestClient(create_app())
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404


def test_health_hides_versions_in_production() -> None:
    async def ok() -> CheckResult:
        return CheckResult(status="ok", latency_ms=1.0, detail="postgis 3.5")

    async def bad() -> CheckResult:
        return CheckResult(status="error", detail="redis unavailable (OSError)")

    prod = Settings(environment="production")
    result = asyncio.run(run_checks({"database": ok, "redis": bad}, prod))
    assert result.checks["database"].detail is None
    assert result.checks["redis"].detail == "redis unavailable (OSError)"
    dev = asyncio.run(run_checks({"database": ok}, Settings()))
    assert dev.checks["database"].detail == "postgis 3.5"
