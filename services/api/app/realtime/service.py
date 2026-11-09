"""The API's view of real-time data: cached feed snapshots (written by the worker) and the
on-demand EMT client. Injected as a FastAPI dependency so tests can replace it."""

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx
from pydantic import BaseModel

from app.config import Settings, get_settings
from app.realtime import emt
from app.realtime.cache import (
    EMT_ALERTS,
    KV,
    RENFE_ALERTS,
    RENFE_SNAPSHOT,
    WORKER_STATUS,
    get_kv,
    get_model,
)
from app.realtime.emt import EmtArrivalsService, EmtClient, LiveFetch
from app.realtime.models import AlertSnapshot, FeedSnapshot
from app.realtime.resilience import Upstream, UpstreamStatus

log = logging.getLogger(__name__)


def crtm_realtime_enabled(settings: Settings) -> bool:
    """CRTM real-time stays off until CRTM authorizes it in writing (ADR 002). No adapter is
    implemented yet: CRTM's answer will decide which interface to build against. Even
    then it may only run with an authorization reference configured."""
    implemented = False
    return implemented and bool(settings.crtm_authorization_ref.strip())


class WorkerStatus(BaseModel):
    updated_at: datetime
    upstreams: list[UpstreamStatus]
    last_poll: dict[str, str]  # source -> "ok" or the error


@dataclass
class Realtime:
    kv: KV
    emt_service: EmtArrivalsService | None
    upstreams: list[Upstream] = field(default_factory=list)

    async def _get[M: BaseModel](self, key: str, cls: type[M]) -> M | None:
        try:
            return await get_model(self.kv, key, cls)
        except Exception as exc:  # noqa: BLE001 - Redis down: no live data, not a 500
            log.warning("cache read %s failed: %s", key, type(exc).__name__)
            return None

    async def renfe_snapshot(self) -> FeedSnapshot | None:
        return await self._get(RENFE_SNAPSHOT, FeedSnapshot)

    async def alert_snapshots(self) -> list[AlertSnapshot]:
        out = []
        for key in (RENFE_ALERTS, EMT_ALERTS):
            snap = await self._get(key, AlertSnapshot)
            if snap is not None:
                out.append(snap)
        return out

    async def emt_arrivals(self, stop_code: str) -> LiveFetch:
        if self.emt_service is None:
            return LiveFetch(None, error="not_configured")
        return await self.emt_service.get(stop_code)

    async def worker_status(self) -> WorkerStatus | None:
        return await self._get(WORKER_STATUS, WorkerStatus)


USER_AGENT = "MadridGo/0.1 (+https://github.com/GrowingRui/MadridGo)"
_realtime: Realtime | None = None
_http: httpx.AsyncClient | None = None


def build_realtime(settings: Settings, kv: KV, http: httpx.AsyncClient) -> Realtime:
    upstreams = []
    emt_service = None
    if settings.emt_configured:
        up = Upstream(name=emt.SOURCE, client=http)
        upstreams.append(up)
        client = EmtClient(
            upstream=up,
            client_id=settings.emt_client_id.get_secret_value(),
            pass_key=settings.emt_pass_key.get_secret_value(),
        )
        emt_service = EmtArrivalsService(kv=kv, fetch=client.arrivals)
    return Realtime(kv=kv, emt_service=emt_service, upstreams=upstreams)


def get_realtime() -> Realtime:
    global _realtime, _http
    if _realtime is None:
        _http = httpx.AsyncClient(headers={"User-Agent": USER_AGENT})
        _realtime = build_realtime(get_settings(), get_kv(), _http)
    return _realtime


async def close_realtime() -> None:
    global _realtime, _http
    if _http is not None:
        await _http.aclose()
    _realtime = _http = None


def now_utc() -> datetime:
    return datetime.now(UTC)
