"""Database helpers: connection pool and a minimal forward-only SQL migration runner."""

from importlib import resources

import asyncpg

MIGRATIONS_PACKAGE = "app.migrations"


async def create_pool(dsn: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(dsn, min_size=1, max_size=10, command_timeout=30)


def migration_files() -> list[tuple[str, str]]:
    """Return (version, sql) pairs in order. Version is the file name without '.sql'."""
    files = [f for f in resources.files(MIGRATIONS_PACKAGE).iterdir() if f.name.endswith(".sql")]
    return [(f.name.removesuffix(".sql"), f.read_text("utf-8")) for f in sorted(files, key=str)]


async def migrate(conn: asyncpg.Connection) -> list[str]:
    """Apply pending migrations, each in its own transaction. Returns applied versions."""
    await conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migration ("
        " version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    )
    # Serialize concurrent migrators (for example the API and a CLI run starting together).
    await conn.execute("SELECT pg_advisory_lock(727001)")
    try:
        done = {r["version"] for r in await conn.fetch("SELECT version FROM schema_migration")}
        applied = []
        for version, sql in migration_files():
            if version in done:
                continue
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute("INSERT INTO schema_migration (version) VALUES ($1)", version)
            applied.append(version)
        return applied
    finally:
        await conn.execute("SELECT pg_advisory_unlock(727001)")
