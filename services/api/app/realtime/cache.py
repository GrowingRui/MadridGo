"""Shared cache for real-time state (Redis in the stack, memory in tests).

Values keep their own `source_timestamp` and `retrieved_at`, and freshness is computed when
they are read. The TTL is deliberately longer than the STALE threshold: an old value is
still useful to say "Outdated, last update 12 min ago" instead of "no data", but it is
never shown as live (freshness.is_usable).
"""

import time
from collections.abc import Callable
from typing import Protocol

import redis.asyncio as aioredis
from pydantic import BaseModel, ValidationError

from app.config import get_settings

# Keys
RENFE_SNAPSHOT = "rt:renfe_gtfsrt:snapshot"
RENFE_ALERTS = "rt:renfe_alerts:snapshot"
EMT_ALERTS = "rt:emt_rss:snapshot"
WORKER_STATUS = "rt:worker:status"


def emt_arrivals_key(stop_code: str) -> str:
    return f"rt:emt_mobilitylabs:arrivals:{stop_code}"


class KV(Protocol):
    async def get(self, key: str) -> bytes | None: ...
    async def set(self, key: str, value: bytes, ttl_s: int) -> None: ...


class MemoryKV:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._data: dict[str, tuple[float, bytes]] = {}
        self._clock = clock

    async def get(self, key: str) -> bytes | None:
        item = self._data.get(key)
        if item is None or item[0] <= self._clock():
            return None
        return item[1]

    async def set(self, key: str, value: bytes, ttl_s: int) -> None:
        self._data[key] = (self._clock() + ttl_s, value)


class RedisKV:
    def __init__(self, client: aioredis.Redis) -> None:
        self._r = client

    async def get(self, key: str) -> bytes | None:
        value = await self._r.get(key)
        return value if isinstance(value, bytes) else None

    async def set(self, key: str, value: bytes, ttl_s: int) -> None:
        await self._r.set(key, value, ex=ttl_s)


async def put_model(kv: KV, key: str, model: BaseModel, ttl_s: int) -> None:
    await kv.set(key, model.model_dump_json().encode(), ttl_s)


async def get_model[M: BaseModel](kv: KV, key: str, cls: type[M]) -> M | None:
    raw = await kv.get(key)
    if raw is None:
        return None
    try:
        return cls.model_validate_json(raw)
    except ValidationError:  # written by an older version: treat as missing
        return None


_redis: aioredis.Redis | None = None


def get_kv() -> KV:
    """The process-wide Redis cache (connections are opened lazily)."""
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(  # type: ignore[no-untyped-call]
            get_settings().redis_url.get_secret_value(),
            socket_connect_timeout=1,
            socket_timeout=1,
        )
    return RedisKV(_redis)


async def close_kv() -> None:
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None
