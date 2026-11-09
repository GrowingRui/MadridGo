"""FastAPI application entry point."""

from typing import Annotated

from fastapi import Depends, FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.config import Settings, get_settings
from app.health import Check, HealthResponse, make_database_check, make_redis_check, run_checks


def get_health_checks(settings: Annotated[Settings, Depends(get_settings)]) -> dict[str, Check]:
    return {
        "database": make_database_check(settings),
        "redis": make_redis_check(settings),
    }


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="MadridGo API", version=__version__)
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

    return app


app = create_app()
