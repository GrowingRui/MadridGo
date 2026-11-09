"""Calling upstream sources safely: timeouts, retries, 429 back-off and a circuit breaker.

Defaults follow RELIABILITY_STRATEGY.md §7. The clock, sleep and random source are
injectable so the reliability scenarios (R7-R9) are tested without waiting.
"""

import asyncio
import random
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any, Literal

import httpx
from pydantic import BaseModel

Clock = Callable[[], float]
Sleep = Callable[[float], Awaitable[None]]


class UpstreamUnavailable(Exception):
    """The source could not be used; the caller falls back to cache or schedule."""

    reason = "unavailable"


class CircuitOpen(UpstreamUnavailable):
    reason = "circuit_open"


class RateLimited(UpstreamUnavailable):
    reason = "rate_limited"

    def __init__(self, retry_after_s: float) -> None:
        super().__init__(f"rate limited for {retry_after_s:.0f} s")
        self.retry_after_s = retry_after_s


class UpstreamFailed(UpstreamUnavailable):
    reason = "failed"


@dataclass(frozen=True)
class RetryPolicy:
    max_retries: int = 2
    backoff_s: tuple[float, ...] = (0.5, 1.5)
    jitter: float = 0.2  # each wait is stretched by up to this fraction, at random
    connect_timeout_s: float = 3.0
    read_timeout_s: float = 5.0
    default_retry_after_s: float = 60.0
    max_retry_after_s: float = 3600.0


BreakerState = Literal["closed", "open", "half_open"]


class CircuitBreaker:
    """Opens after `failure_threshold` consecutive failures, or when more than
    `failure_rate` of at least `min_calls` calls in the last `window_s` failed. While open,
    no calls are made; after `open_s` one probe call is let through (half-open)."""

    def __init__(
        self,
        *,
        failure_threshold: int = 5,
        failure_rate: float = 0.5,
        min_calls: int = 10,
        window_s: float = 60.0,
        open_s: float = 30.0,
        clock: Clock = time.monotonic,
    ) -> None:
        self.failure_threshold = failure_threshold
        self.failure_rate = failure_rate
        self.min_calls = min_calls
        self.window_s = window_s
        self.open_s = open_s
        self._clock = clock
        self.state: BreakerState = "closed"
        self.opened_at: float | None = None
        self.openings = 0
        self._consecutive = 0
        self._events: deque[tuple[float, bool]] = deque()
        self._probe_in_flight = False

    def allow(self) -> bool:
        now = self._clock()
        if self.state == "open":
            assert self.opened_at is not None  # noqa: S101
            if now - self.opened_at < self.open_s:
                return False
            self.state = "half_open"
            self._probe_in_flight = False
        if self.state == "half_open":
            if self._probe_in_flight:
                return False
            self._probe_in_flight = True
        return True

    def _record(self, ok: bool) -> None:
        now = self._clock()
        self._events.append((now, ok))
        while self._events and now - self._events[0][0] > self.window_s:
            self._events.popleft()

    def success(self) -> None:
        self._record(True)
        self._consecutive = 0
        if self.state == "half_open":
            self.state = "closed"
            self._events.clear()
        self._probe_in_flight = False

    def failure(self) -> None:
        self._record(False)
        self._consecutive += 1
        failures = sum(1 for _, ok in self._events if not ok)
        too_many = self._consecutive >= self.failure_threshold or (
            len(self._events) >= self.min_calls and failures / len(self._events) > self.failure_rate
        )
        if self.state == "half_open" or too_many:
            self._open()

    def release(self) -> None:
        """A call ended without telling us anything about health (for example a 429)."""
        self._probe_in_flight = False

    def _open(self) -> None:
        if self.state != "open":
            self.openings += 1
        self.state = "open"
        self.opened_at = self._clock()
        self._probe_in_flight = False


class UpstreamStats(BaseModel):
    requests: int = 0  # HTTP requests actually sent
    successes: int = 0
    failures: int = 0
    retries: int = 0
    rate_limited: int = 0
    short_circuited: int = 0  # calls refused locally (breaker open or 429 back-off)
    last_success_at: datetime | None = None
    last_failure_at: datetime | None = None
    last_error: str | None = None
    last_latency_ms: float | None = None


class UpstreamStatus(BaseModel):
    name: str
    breaker: BreakerState
    breaker_openings: int
    blocked_for_s: float | None
    stats: UpstreamStats


def parse_retry_after(value: str | None, now: datetime, policy: RetryPolicy) -> float:
    if not value:
        return policy.default_retry_after_s
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = (parsedate_to_datetime(value) - now).total_seconds()
        except (TypeError, ValueError):
            return policy.default_retry_after_s
    return min(max(seconds, 0.0), policy.max_retry_after_s)


@dataclass
class Upstream:
    """One upstream host. All calls to that host go through `request`."""

    name: str
    client: httpx.AsyncClient
    breaker: CircuitBreaker = field(default_factory=CircuitBreaker)
    policy: RetryPolicy = field(default_factory=RetryPolicy)
    sleep: Sleep = asyncio.sleep
    clock: Clock = time.monotonic
    wallclock: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    rng: Callable[[], float] = random.random
    stats: UpstreamStats = field(default_factory=UpstreamStats)
    blocked_until: float = 0.0

    def status(self) -> UpstreamStatus:
        left = self.blocked_until - self.clock()
        return UpstreamStatus(
            name=self.name,
            breaker=self.breaker.state,
            breaker_openings=self.breaker.openings,
            blocked_for_s=round(left, 1) if left > 0 else None,
            stats=self.stats.model_copy(),
        )

    def report_success(self) -> None:
        """Confirm a response returned with `judged=True` was usable."""
        self.breaker.success()
        self.stats.successes += 1
        self.stats.last_success_at = self.wallclock()

    def report_failure(self, error: str) -> None:
        """For failures only the caller can see (an error code inside a 200 response)."""
        self.breaker.failure()
        self._failed(error)

    def _failed(self, error: str) -> None:
        self.stats.failures += 1
        self.stats.last_failure_at = self.wallclock()
        self.stats.last_error = error

    async def request(
        self,
        method: str,
        url: str,
        *,
        deadline_s: float = 6.0,
        judged: bool = False,
        **kwargs: Any,
    ) -> httpx.Response:
        """Send a request with retries, inside an overall deadline.

        Returns any response below 500 except 429. Raises RateLimited, CircuitOpen or
        UpstreamFailed instead of returning anything the caller could mistake for data.
        With `judged=True` the caller decides whether the response was a success and must
        call report_success() or report_failure(): an HTTP 403 or an error code inside a
        200 is a failure the breaker has to count.
        """
        if self.clock() < self.blocked_until:
            self.stats.short_circuited += 1
            raise RateLimited(self.blocked_until - self.clock())
        if not self.breaker.allow():
            self.stats.short_circuited += 1
            raise CircuitOpen(f"{self.name}: circuit open")

        p = self.policy
        timeout = httpx.Timeout(p.read_timeout_s, connect=p.connect_timeout_s)
        start = self.clock()
        error = "deadline exceeded"
        for attempt in range(p.max_retries + 1):
            remaining = deadline_s - (self.clock() - start)
            if remaining <= 0:
                break
            self.stats.requests += 1
            t0 = time.perf_counter()
            try:
                async with asyncio.timeout(remaining):
                    resp = await self.client.request(method, url, timeout=timeout, **kwargs)
            except (TimeoutError, httpx.TimeoutException):
                error = "timeout"
            except httpx.TransportError as exc:
                error = type(exc).__name__
            else:
                self.stats.last_latency_ms = round((time.perf_counter() - t0) * 1000, 1)
                if resp.status_code == 429:
                    wait = parse_retry_after(resp.headers.get("retry-after"), self.wallclock(), p)
                    self.blocked_until = self.clock() + wait
                    self.stats.rate_limited += 1
                    self.breaker.release()
                    raise RateLimited(wait)
                if resp.status_code < 500:
                    if not judged:
                        self.report_success()
                    return resp
                error = f"HTTP {resp.status_code}"
            if attempt == p.max_retries:
                break
            wait = p.backoff_s[min(attempt, len(p.backoff_s) - 1)] * (1 + p.jitter * self.rng())
            if self.clock() - start + wait >= deadline_s:
                break
            self.stats.retries += 1
            await self.sleep(wait)

        self.breaker.failure()
        self._failed(error)
        raise UpstreamFailed(f"{self.name}: {error}")
