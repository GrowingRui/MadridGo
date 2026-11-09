"""A lazily created asyncpg pool shared by request handlers.

Lazy creation lets the API start (and report a failing /health) while the database is down.
"""

import asyncio

import asyncpg
from fastapi import HTTPException

from app.config import get_settings
from app.db import create_pool

_pool: asyncpg.Pool | None = None
_lock = asyncio.Lock()


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        async with _lock:
            if _pool is None:
                try:
                    _pool = await create_pool(get_settings().database_url.get_secret_value())
                except (OSError, asyncpg.PostgresError) as exc:
                    raise HTTPException(
                        status_code=503, detail=f"Database unavailable ({type(exc).__name__})"
                    ) from exc
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
