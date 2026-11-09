"""Health checks for the API's dependencies.

Each check is an async callable returning a CheckResult. Checks are injected via
FastAPI dependencies so tests can replace them without real services.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Literal

import asyncpg
import redis.asyncio as aioredis
from pydantic import BaseModel

from app import __version__
from app.config import Settings

Status = Literal["ok", "error"]


class CheckResult(BaseModel):
    status: Status
    latency_ms: float | None = None
    detail: str | None = None


class HealthResponse(BaseModel):
    status: Status
    version: str
    environment: str
    checked_at: datetime
    checks: dict[str, CheckResult]


Check = Callable[[], Awaitable[CheckResult]]


async def _timed(
    name: str, fn: Callable[[], Awaitable[str | None]], timeout_s: float
) -> CheckResult:
    start = time.perf_counter()
    try:
        detail = await asyncio.wait_for(fn(), timeout=timeout_s)
    except TimeoutError:
        return CheckResult(status="error", detail=f"{name} timed out after {timeout_s}s")
    except Exception as exc:  # noqa: BLE001 - report any dependency failure, never crash /health
        # Only the exception type is exposed: messages may contain connection strings.
        return CheckResult(status="error", detail=f"{name} unavailable ({type(exc).__name__})")
    return CheckResult(
        status="ok", latency_ms=round((time.perf_counter() - start) * 1000, 1), detail=detail
    )


def make_database_check(settings: Settings) -> Check:
    async def query() -> str | None:
        conn = await asyncpg.connect(settings.database_url.get_secret_value())
        try:
            version = await conn.fetchval("SELECT postgis_lib_version()")
            return f"postgis {version}"
        finally:
            await conn.close()

    async def check() -> CheckResult:
        return await _timed("database", query, settings.health_check_timeout_s)

    return check


def make_redis_check(settings: Settings) -> Check:
    async def ping() -> str | None:
        client = aioredis.from_url(  # type: ignore[no-untyped-call]
            settings.redis_url.get_secret_value()
        )
        try:
            await client.ping()
            return None
        finally:
            await client.aclose()

    async def check() -> CheckResult:
        return await _timed("redis", ping, settings.health_check_timeout_s)

    return check


async def run_checks(checks: dict[str, Check], settings: Settings) -> HealthResponse:
    names = list(checks)
    results = await asyncio.gather(*(checks[n]() for n in names))
    by_name = dict(zip(names, results, strict=True))
    overall: Status = "ok" if all(r.status == "ok" for r in results) else "error"
    return HealthResponse(
        status=overall,
        version=__version__,
        environment=settings.environment,
        checked_at=datetime.now(UTC),
        checks=by_name,
    )
