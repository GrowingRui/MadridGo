"""FastAPI application entry point."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Annotated

import asyncpg
from fastapi import Depends, FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware

from app import __version__, journeys, stops
from app.config import Settings, get_settings
from app.dbpool import close_pool, get_pool
from app.feeds import FeedStatus, feed_statuses
from app.health import Check, HealthResponse, make_database_check, make_redis_check, run_checks
from app.otp import close_otp
from app.realtime import api as realtime_api
from app.realtime.cache import close_kv
from app.realtime.service import close_realtime
from app.timetable import MADRID


def get_health_checks(settings: Annotated[Settings, Depends(get_settings)]) -> dict[str, Check]:
    return {
        "database": make_database_check(settings),
        "redis": make_redis_check(settings),
    }


def create_app() -> FastAPI:
    settings = get_settings()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await close_otp()
        await close_realtime()
        await close_kv()
        await close_pool()

    app = FastAPI(title="MadridGo API", version=__version__, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    @app.get("/health", response_model=HealthResponse, tags=["system"])
    async def health(
        response: Response,
        settings: Annotated[Settings, Depends(get_settings)],
        checks: Annotated[dict[str, Check], Depends(get_health_checks)],
    ) -> HealthResponse:
        """Report API status and the status of each dependency.

        Returns 503 if any dependency is failing, so load balancers and uptime
        monitors can detect a degraded backend.
        """
        result = await run_checks(checks, settings)
        if result.status != "ok":
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return result

    @app.get("/feeds", response_model=list[FeedStatus], tags=["system"])
    async def feeds(pool: Annotated[asyncpg.Pool, Depends(get_pool)]) -> list[FeedStatus]:
        """Active static timetable versions, their validity and expiry state."""
        return await feed_statuses(pool, datetime.now(MADRID).date())

    app.include_router(stops.router)
    app.include_router(journeys.router)
    app.include_router(realtime_api.router)
    return app


app = create_app()
