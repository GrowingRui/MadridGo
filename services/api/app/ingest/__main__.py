"""Static data pipeline CLI.

    python -m app.ingest migrate                 apply database migrations
    python -m app.ingest update [-s KEY,...]     download, validate, import and activate feeds
    python -m app.ingest validate [-s KEY,...]   validate the active versions again
    python -m app.ingest status                  show active feed versions and expiry
    python -m app.ingest otp-prepare             assemble OTP inputs in data/otp/

Run from services/api with the venv active and MADRIDGO_DATABASE_URL set (see .env).
"""

import argparse
import asyncio
import logging
import shutil
import sys
import zipfile
from datetime import UTC, date, datetime
from pathlib import Path

import asyncpg

from app.config import get_settings
from app.db import migrate
from app.feeds import expiry_state
from app.ingest.download import download
from app.ingest.gtfs import GtfsZip
from app.ingest.importer import delete_version, import_feed
from app.ingest.shapes import repair_shapes
from app.ingest.sources import GTFS_SOURCES, OSM_MADRID_URL, SOURCES_BY_KEY, GtfsSource
from app.ingest.subset import subset
from app.ingest.validate import validate

log = logging.getLogger("ingest")


def data_dir() -> Path:
    """The repo's data/ folder (found by walking up from the working directory)."""
    configured = get_settings().data_dir
    if configured:
        return Path(configured)
    for d in (Path.cwd(), *Path.cwd().parents):
        if (d / "infra" / "docker-compose.yml").exists():
            return d / "data"
    return Path.cwd() / "data"


def flatten(src: Path, dest: Path) -> Path:
    """Copy a GTFS zip so its .txt files sit at the zip root (OTP and the validator need this)."""
    with GtfsZip(src) as feed:
        if not feed.prefix:
            shutil.copyfile(src, dest)
            return dest
        prefix = feed.prefix
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            if info.filename.startswith(prefix) and not info.is_dir():
                with zin.open(info) as r, zout.open(info.filename.removeprefix(prefix), "w") as w:
                    shutil.copyfileobj(r, w, 1 << 20)
    return dest


async def _connect() -> asyncpg.Connection:
    conn = await asyncpg.connect(get_settings().database_url.get_secret_value())
    await migrate(conn)
    return conn


async def cmd_migrate() -> int:
    conn = await asyncpg.connect(get_settings().database_url.get_secret_value())
    try:
        applied = await migrate(conn)
        print("applied: " + (", ".join(applied) if applied else "nothing (up to date)"))
    finally:
        await conn.close()
    return 0


async def update_source(
    conn: asyncpg.Connection, source: GtfsSource, root: Path, *, force: bool, skip_validate: bool
) -> bool:
    print(f"[{source.key}] downloading")
    dl = download(source.url, root / "gtfs" / "raw", source.key)
    active_sha = await conn.fetchval(
        "SELECT sha256 FROM feed_version WHERE source = $1 AND is_active", source.key
    )
    if active_sha == dl.sha256 and not force:
        print(f"[{source.key}] unchanged ({dl.sha256[:12]}), already active")
        return True
    flat_dir = root / "gtfs" / "flat"
    flat_dir.mkdir(parents=True, exist_ok=True)
    flat_path = flat_dir / f"{source.key}-{dl.sha256[:12]}.zip"
    if source.route_prefix:
        kept = subset(dl.path, flat_path, source.route_prefix, source.stop_positions)
        print(f"[{source.key}] kept routes {source.route_prefix}*: {kept}")
        flat = flat_path
    else:
        flat = flatten(dl.path, flat_path)
    if source.repair_shapes:
        fixed = repair_shapes(flat)
        print(
            f"[{source.key}] shapes: {fixed.patterns} trip patterns, {fixed.kept} fitted, "
            f"{fixed.reversed} reversed, {fixed.stitched} stitched ({fixed.straight_hops} hops "
            f"on no shape), {fixed.dropped} dropped (drawn straight)"
        )

    summary = None
    if not skip_validate:
        print(f"[{source.key}] validating (MobilityData gtfs-validator)")
        summary = validate(flat, root / "validation" / source.key / dl.sha256[:12])
        print(
            f"[{source.key}] validation: {summary.status}, {summary.errors} errors, "
            f"{summary.warnings} warnings {summary.top_errors or ''}"
        )
    print(f"[{source.key}] importing {dl.size / 1e6:.1f} MB")
    started = datetime.now(UTC)
    result = await import_feed(conn, source, flat, dl.sha256, started)
    if summary:
        await conn.execute(
            """UPDATE feed_version SET validation_status = $2, validation_errors = $3,
                   validation_warnings = $4, validation_report = $5 WHERE id = $1""",
            result.feed_version_id,
            summary.status,
            summary.errors,
            summary.warnings,
            str(summary.report_dir),
        )
    took = (datetime.now(UTC) - started).total_seconds()
    print(
        f"[{source.key}] active as version {result.feed_version_id} in {took:.0f}s: "
        f"{result.row_counts}; service {result.service_start} -> {result.service_end}"
    )
    return True


async def cmd_update(keys: list[str], force: bool, skip_validate: bool) -> int:
    sources = [SOURCES_BY_KEY[k] for k in keys] if keys else list(GTFS_SOURCES)
    root = data_dir()
    conn = await _connect()
    failed = []
    try:
        if not await conn.fetchval("SELECT pg_try_advisory_lock(727002)"):
            print("another update is running", file=sys.stderr)
            return 1
        # Versions left half-imported by a killed run (imports clean up after normal errors).
        for r in await conn.fetch("SELECT id FROM feed_version WHERE imported_at IS NULL"):
            print(f"removing incomplete version {r['id']}")
            await delete_version(conn, r["id"])
        for source in sources:
            try:
                await update_source(conn, source, root, force=force, skip_validate=skip_validate)
            except Exception as exc:  # noqa: BLE001 - one bad feed must not stop the others
                log.exception("[%s] failed", source.key)
                failed.append(f"{source.key}: {type(exc).__name__}: {exc}")
    finally:
        await conn.close()
    if failed:
        print("FAILED:\n  " + "\n  ".join(failed), file=sys.stderr)
        return 1
    return 0


async def cmd_validate(keys: list[str]) -> int:
    root = data_dir()
    conn = await _connect()
    worst = 0
    try:
        rows = await conn.fetch(
            "SELECT id, source, sha256, file_path FROM feed_version WHERE is_active ORDER BY source"
        )
        for r in rows:
            if keys and r["source"] not in keys:
                continue
            print(f"[{r['source']}] validating {Path(r['file_path']).name}")
            summary = validate(
                Path(r["file_path"]), root / "validation" / r["source"] / r["sha256"][:12]
            )
            await conn.execute(
                """UPDATE feed_version SET validation_status = $2, validation_errors = $3,
                       validation_warnings = $4, validation_report = $5 WHERE id = $1""",
                r["id"],
                summary.status,
                summary.errors,
                summary.warnings,
                str(summary.report_dir),
            )
            print(
                f"[{r['source']}] {summary.status}: {summary.errors} errors, "
                f"{summary.warnings} warnings {summary.top_errors or ''}"
            )
            if summary.status in ("errors", "failed"):
                worst = 1
    finally:
        await conn.close()
    return worst


async def cmd_status() -> int:
    conn = await _connect()
    try:
        rows = await conn.fetch(
            """SELECT source, id, feed_version_label, service_start, service_end,
                      validation_status, validation_errors, imported_at
               FROM feed_version WHERE is_active ORDER BY source"""
        )
    finally:
        await conn.close()
    today = date.today()
    missing = {s.key for s in GTFS_SOURCES} - {r["source"] for r in rows}
    worst = 0
    for r in rows:
        src = SOURCES_BY_KEY.get(r["source"])
        state, days = expiry_state(r["service_end"], today, src.expiry_warning_days if src else 14)
        worst = max(worst, {"ok": 0, "expiring": 1, "expired": 2}[state])
        print(
            f"{r['source']:<11} v{r['id']:<4} label={r['feed_version_label'] or '-':<9} "
            f"{r['service_start']} -> {r['service_end']}  {state.upper():<8} ({days:+d} d)  "
            f"validation={r['validation_status']}"
            + (f" ({r['validation_errors']} errors)" if r["validation_errors"] else "")
        )
    for key in sorted(missing):
        print(f"{key:<11} NOT IMPORTED")
    # Non-zero exit lets a scheduler alert on expired data.
    return 2 if worst == 2 or missing else 0


async def cmd_otp_prepare() -> int:
    root = data_dir()
    otp = root / "otp"
    otp.mkdir(parents=True, exist_ok=True)
    conn = await _connect()
    try:
        rows = await conn.fetch("SELECT source, file_path FROM feed_version WHERE is_active")
    finally:
        await conn.close()
    for old in otp.glob("*-gtfs.zip"):
        old.unlink()
    for r in rows:
        dest = otp / f"{r['source']}-gtfs.zip"  # OTP detects GTFS by 'gtfs' in the name
        shutil.copyfile(r["file_path"], dest)
        print(f"{dest.name} <- {Path(r['file_path']).name}")
    osm = otp / "madrid.osm.pbf"
    if not osm.exists():
        print("downloading Geofabrik Madrid OSM extract")
        dl = download(OSM_MADRID_URL, root / "osm", "madrid")
        shutil.copyfile(dl.path, osm)
    print(f"OTP inputs ready in {otp}")
    return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(prog="python -m app.ingest")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate")
    up = sub.add_parser("update")
    up.add_argument("-s", "--sources", default="", help="comma-separated keys; default all")
    up.add_argument("--force", action="store_true", help="re-import even if unchanged")
    up.add_argument("--skip-validate", action="store_true")
    va = sub.add_parser("validate")
    va.add_argument("-s", "--sources", default="", help="comma-separated keys; default all")
    sub.add_parser("status")
    sub.add_parser("otp-prepare")
    args = parser.parse_args()

    if args.cmd == "migrate":
        return asyncio.run(cmd_migrate())
    if args.cmd == "update":
        keys = [k.strip() for k in args.sources.split(",") if k.strip()]
        unknown = [k for k in keys if k not in SOURCES_BY_KEY]
        if unknown:
            parser.error(f"unknown source(s) {unknown}; known: {sorted(SOURCES_BY_KEY)}")
        return asyncio.run(cmd_update(keys, args.force, args.skip_validate))
    if args.cmd == "validate":
        return asyncio.run(cmd_validate([k for k in args.sources.split(",") if k]))
    if args.cmd == "status":
        return asyncio.run(cmd_status())
    return asyncio.run(cmd_otp_prepare())


if __name__ == "__main__":
    sys.exit(main())
