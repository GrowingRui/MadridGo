import asyncio
import os

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.health import CheckResult, _timed
from app.main import app, get_health_checks


def _fixed(result: CheckResult):  # type: ignore[no-untyped-def]
    async def check() -> CheckResult:
        return result

    return check


@pytest.fixture
def client():  # type: ignore[no-untyped-def]
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_health_ok_when_all_dependencies_ok(client: TestClient) -> None:
    app.dependency_overrides[get_health_checks] = lambda: {
        "database": _fixed(CheckResult(status="ok", latency_ms=1.0, detail="postgis 3.5")),
        "redis": _fixed(CheckResult(status="ok", latency_ms=0.5)),
    }
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert set(body["checks"]) == {"database", "redis"}
    assert body["checked_at"].endswith("Z") or "+00:00" in body["checked_at"]


def test_health_503_when_any_dependency_fails(client: TestClient) -> None:
    app.dependency_overrides[get_health_checks] = lambda: {
        "database": _fixed(CheckResult(status="ok")),
        "redis": _fixed(CheckResult(status="error", detail="redis unavailable (ConnectionError)")),
    }
    resp = client.get("/health")
    assert resp.status_code == 503
    assert resp.json()["status"] == "error"
    assert resp.json()["checks"]["redis"]["status"] == "error"


def test_timed_reports_timeout() -> None:
    async def slow() -> str | None:
        await asyncio.sleep(1)
        return None

    result = asyncio.run(_timed("db", slow, timeout_s=0.01))
    assert result.status == "error"
    assert "timed out" in (result.detail or "")


def test_timed_hides_exception_message() -> None:
    secret = "postgresql://user:hunter2@host/db"

    async def boom() -> str | None:
        raise OSError(f"could not connect to {secret}")

    result = asyncio.run(_timed("database", boom, timeout_s=1))
    assert result.status == "error"
    assert "hunter2" not in (result.detail or "")
    assert result.detail == "database unavailable (OSError)"


def test_settings_do_not_leak_secrets_in_repr() -> None:
    s = Settings(database_url="postgresql://u:topsecret@h/db")  # type: ignore[arg-type]
    assert "topsecret" not in repr(s)


@pytest.mark.integration
@pytest.mark.skipif(os.getenv("MADRIDGO_INTEGRATION") != "1", reason="needs docker compose stack")
def test_health_against_real_services() -> None:
    with TestClient(app) as c:
        resp = c.get("/health")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["checks"]["database"]["detail"].startswith("postgis ")
    assert body["checks"]["redis"]["status"] == "ok"
