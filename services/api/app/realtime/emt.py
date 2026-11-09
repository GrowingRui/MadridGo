"""EMT Madrid MobilityLabs: on-demand arrivals per stop, and the incidents RSS feed.

Arrivals (https://apidocs.emtmadrid.es): `estimateArrive` is seconds until the bus arrives,
999999 meaning "more than 45 min" (90 min for night lines). The response carries only the
server's answer time, not an observation time, so ages are measured from retrieval and
labelled as such (RELIABILITY_STRATEGY.md §2).

Login uses the registered application's X-ClientId + passKey (backend .env only).
"""

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Any

import defusedxml.ElementTree as SafeET
import httpx

from app.realtime.cache import KV, emt_arrivals_key, get_model, put_model
from app.realtime.models import AlertSnapshot, EmtArrival, EmtArrivals, ServiceAlert
from app.realtime.resilience import Upstream, UpstreamFailed, UpstreamUnavailable
from app.timetable import MADRID

log = logging.getLogger(__name__)

SOURCE = "emt_mobilitylabs"
RSS_SOURCE = "emt_rss"
OPERATOR = "EMT_MADRID"
ATTRIBUTION = "Powered by EMT de Madrid"
BASE_URL = "https://openapi.emtmadrid.es"
LOGIN_PATH = "/v1/mobilitylabs/user/login/"
ARRIVALS_PATH = "/v2/transport/busemtmad/stops/{stop}/arrives/"
RSS_URL = "http://servicios.emtmadrid.es:8080/rss/emtrss.xml"

BEYOND_HORIZON = 999999
CODE_NO_SESSION = "80"  # "Token not found": log in again
# Reuse a cached answer for this long before asking EMT again (all users share it).
REUSE_S = 20
# Keep answers for this long so an outage can still show "last update N min ago".
KEEP_S = 15 * 60
DEADLINE_S = 4.0


class EmtError(UpstreamFailed):
    pass


def _server_time(value: Any) -> datetime | None:
    """The API's `datetime` is Madrid local time without an offset."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value).replace(tzinfo=MADRID)
    except ValueError:
        return None


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_arrivals(stop_code: str, body: dict[str, Any], retrieved_at: datetime) -> EmtArrivals:
    code = str(body.get("code", ""))
    if code != "00":
        raise EmtError(f"EMT code {code}: {body.get('description', '')}".strip())
    arrivals: list[EmtArrival] = []
    for block in body.get("data") or []:
        for a in block.get("Arrive") or []:
            seconds = _int(a.get("estimateArrive"))
            arrivals.append(
                EmtArrival(
                    line=str(a.get("line", "")).strip(),
                    destination=(str(a["destination"]).strip() or None)
                    if a.get("destination")
                    else None,
                    seconds=None if seconds is None or seconds >= BEYOND_HORIZON else seconds,
                    vehicle_id=str(a["bus"]) if a.get("bus") not in (None, "", 0) else None,
                    distance_m=_int(a.get("DistanceBus")),
                )
            )
    arrivals.sort(key=lambda x: (x.seconds is None, x.seconds or 0))
    return EmtArrivals(
        stop_code=stop_code,
        retrieved_at=retrieved_at,
        server_time=_server_time(body.get("datetime")),
        arrivals=arrivals,
    )


@dataclass
class EmtClient:
    upstream: Upstream
    client_id: str
    pass_key: str
    wallclock: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    _token: str | None = None
    _token_expires: datetime | None = None
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def _login(self) -> str:
        resp = await self.upstream.request(
            "GET",
            BASE_URL + LOGIN_PATH,
            headers={"X-ClientId": self.client_id, "passKey": self.pass_key},
            deadline_s=DEADLINE_S,
            judged=True,
        )
        body = self._json(resp)
        data = (body.get("data") or [{}])[0]
        token = data.get("accessToken")
        if resp.status_code != 200 or str(body.get("code")) not in ("00", "01") or not token:
            # 403 with code 84 was observed on 2026-11-09 with valid-looking credentials.
            error = f"EMT login refused (HTTP {resp.status_code}, code {body.get('code')})"
            self.upstream.report_failure(error)
            raise EmtError(error)
        self.upstream.report_success()
        ttl = _int(data.get("tokenSecExpiration")) or 3600
        self._token = str(token)
        self._token_expires = self.wallclock() + timedelta(seconds=max(60, ttl - 60))
        return self._token

    def _json(self, resp: httpx.Response) -> dict[str, Any]:
        """Every judged response must end in report_success or report_failure, or a
        half-open breaker would wait for its probe forever."""
        try:
            body = resp.json() if resp.content else {}
        except ValueError as exc:
            self.upstream.report_failure("invalid JSON")
            raise EmtError("EMT sent invalid JSON") from exc
        if not isinstance(body, dict):
            self.upstream.report_failure("unexpected JSON")
            raise EmtError("EMT sent unexpected JSON")
        return body

    async def token(self, *, force: bool = False) -> str:
        async with self._lock:
            valid = self._token_expires and self.wallclock() < self._token_expires
            if self._token and valid and not force:
                return self._token
            return await self._login()

    async def arrivals(self, stop_code: str) -> EmtArrivals:
        body_req = {
            "cultureInfo": "ES",
            "Text_StopRequired_YN": "N",
            "Text_EstimationsRequired_YN": "Y",
            "Text_IncidencesRequired_YN": "N",
        }
        url = BASE_URL + ARRIVALS_PATH.format(stop=stop_code)
        for attempt in range(2):
            token = await self.token(force=attempt > 0)
            resp = await self.upstream.request(
                "POST",
                url,
                headers={"accessToken": token},
                json=body_req,
                deadline_s=DEADLINE_S,
                judged=True,
            )
            body = self._json(resp)
            expired = resp.status_code == 401 or str(body.get("code")) == CODE_NO_SESSION
            if expired and attempt == 0:
                self.upstream.breaker.release()  # says nothing about EMT's health
                continue  # token expired or revoked: log in again once
            if resp.status_code != 200:
                self.upstream.report_failure(f"HTTP {resp.status_code}")
                raise EmtError(f"EMT arrivals HTTP {resp.status_code}")
            try:
                result = parse_arrivals(stop_code, body, self.wallclock())
            except EmtError as exc:
                self.upstream.report_failure(str(exc))
                raise
            self.upstream.report_success()
            return result
        raise EmtError("EMT token refused twice")


@dataclass
class LiveFetch:
    """What the board gets: data (possibly old, with its true age) and/or why it failed."""

    data: EmtArrivals | None
    error: str | None = None


Fetcher = Callable[[str], Awaitable[EmtArrivals]]


@dataclass
class EmtArrivalsService:
    """Shared cache in front of the API, with request coalescing: many users opening the
    same stop at once cause one upstream call."""

    kv: KV
    fetch: Fetcher
    wallclock: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    _inflight: dict[str, asyncio.Future[EmtArrivals]] = field(default_factory=dict)

    async def get(self, stop_code: str) -> LiveFetch:
        key = emt_arrivals_key(stop_code)
        try:
            cached = await get_model(self.kv, key, EmtArrivals)
        except Exception:  # noqa: BLE001 - a cache outage must not break the board
            cached = None
        if cached and (self.wallclock() - cached.retrieved_at).total_seconds() <= REUSE_S:
            return LiveFetch(cached)
        try:
            fresh = await self._coalesced(stop_code)
        except UpstreamUnavailable as exc:
            return LiveFetch(cached, error=exc.reason)
        except (httpx.HTTPError, ValueError) as exc:  # malformed JSON and the like
            log.warning("EMT arrivals for %s failed: %s", stop_code, type(exc).__name__)
            return LiveFetch(cached, error="failed")
        try:
            await put_model(self.kv, key, fresh, KEEP_S)
        except Exception:  # noqa: BLE001
            log.warning("could not cache EMT arrivals for %s", stop_code)
        return LiveFetch(fresh)

    async def _coalesced(self, stop_code: str) -> EmtArrivals:
        running = self._inflight.get(stop_code)
        if running is not None:
            return await asyncio.shield(running)
        fut: asyncio.Future[EmtArrivals] = asyncio.get_running_loop().create_future()
        self._inflight[stop_code] = fut
        try:
            result = await self.fetch(stop_code)
        except BaseException as exc:
            fut.set_exception(exc)
            fut.exception()  # mark retrieved: waiters re-raise it, nobody else needs to
            raise
        else:
            fut.set_result(result)
            return result
        finally:
            del self._inflight[stop_code]


# --- Incidents RSS -------------------------------------------------------------------------

_TAGS = re.compile(r"<[^>]+>")


def _local(value: str | None) -> datetime | None:
    """'12/11/2026 8:00:00' (Madrid local time)."""
    if not value or not value.strip():
        return None
    try:
        return datetime.strptime(value.strip(), "%d/%m/%Y %H:%M:%S").replace(tzinfo=MADRID)
    except ValueError:
        return None


def _rfc822(value: str | None) -> datetime | None:
    try:
        return parsedate_to_datetime(value) if value else None
    except (TypeError, ValueError):
        return None


def parse_rss(data: bytes, retrieved_at: datetime) -> AlertSnapshot:
    root = SafeET.fromstring(data)
    channel = root.find("channel")
    if channel is None:
        raise ValueError("not an RSS document")
    built = _rfc822(channel.findtext("lastBuildDate"))
    alerts = []
    for item in channel.findall("item"):
        description = item.findtext("description") or ""
        description = " ".join(_TAGS.sub(" ", description).split()) or None
        cause = (item.findtext("GoogleTransitCause") or "").strip() or None
        effect = (item.findtext("GoogleTransitEffect") or "").strip() or None
        alerts.append(
            ServiceAlert(
                source=RSS_SOURCE,
                source_alert_id=(item.findtext("guid") or "").strip(),
                operator=OPERATOR,
                header=(item.findtext("title") or "").strip() or None,
                description=description,
                url=(item.findtext("link") or "").strip() or None,
                cause=cause,
                effect=effect,
                active_from=_local(item.findtext("rssAfectaDesde")),
                active_to=_local(item.findtext("rssAfectaHasta")),
                route_ids=[c.text.strip() for c in item.findall("category") if c.text],
                stop_ids=[],
                source_timestamp=_rfc822(item.findtext("pubDate")) or built,
                retrieved_at=retrieved_at,
            )
        )
    return AlertSnapshot(
        source=RSS_SOURCE, source_timestamp=built, retrieved_at=retrieved_at, alerts=alerts
    )
