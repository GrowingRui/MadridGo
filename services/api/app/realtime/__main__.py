"""Real-time worker CLI.

python -m app.realtime run          poll Renfe (30 s) and alerts (2 min) forever
python -m app.realtime once         one poll of every feed, print a summary
python -m app.realtime calibrate    suggest freshness thresholds from adapter_health
python -m app.realtime accuracy     how close live times came to the real arrivals
"""

import argparse
import asyncio
import json
import logging
from dataclasses import asdict
from datetime import UTC, datetime

import asyncpg
import httpx

from app.config import get_settings
from app.db import create_pool, migrate
from app.realtime import renfe
from app.realtime.accuracy import MIN_DAYS, MIN_SAMPLE, report
from app.realtime.cache import close_kv, get_kv
from app.realtime.freshness import THRESHOLDS
from app.realtime.service import USER_AGENT
from app.realtime.worker import Worker, calibrate, make_upstreams, record_health, run_forever
from app.timetable import MADRID

log = logging.getLogger("app.realtime")


async def _pool() -> asyncpg.Pool | None:
    """The database is optional for polling: without it, health samples are not stored."""
    try:
        pool = await create_pool(get_settings().database_url.get_secret_value())
    except (OSError, asyncpg.PostgresError) as exc:
        log.warning("database unavailable (%s): polling without health records", type(exc).__name__)
        return None
    async with pool.acquire() as conn:
        await migrate(conn)
    return pool


async def _worker(http: httpx.AsyncClient) -> Worker:
    renfe_up, rss_up = make_upstreams(http)
    return Worker(kv=get_kv(), renfe_up=renfe_up, emt_rss_up=rss_up, pool=await _pool())


async def cmd_run() -> None:
    s = get_settings()
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}) as http:
        worker = await _worker(http)
        try:
            await run_forever(worker, s.renfe_poll_s, s.alerts_poll_s)
        finally:
            if worker.pool is not None:
                await worker.pool.close()
            await close_kv()


async def cmd_once() -> None:
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}) as http:
        worker = await _worker(http)
        try:
            samples = [await worker.poll_renfe(), *await worker.poll_alerts()]
            for sample in samples:
                await record_health(worker.pool, sample)
                print(json.dumps(asdict(sample), default=str))
            await worker.publish_status()
        finally:
            if worker.pool is not None:
                await worker.pool.close()
            await close_kv()


async def cmd_calibrate(days: int) -> None:
    pool = await create_pool(get_settings().database_url.get_secret_value())
    try:
        result = await calibrate(pool, renfe.SOURCE, days)
    finally:
        await pool.close()
    current = THRESHOLDS[renfe.SOURCE]
    print(json.dumps(asdict(result), indent=2))
    print(f"current thresholds: FRESH <= {current.fresh_s} s, DELAYED <= {current.delayed_s} s")
    if not result.complete:
        print("note: less than 7 days of data; treat the suggestion as provisional")


async def cmd_accuracy(days: int, lines: bool) -> None:
    pool = await create_pool(get_settings().database_url.get_secret_value())
    try:
        async with pool.acquire() as conn:
            await migrate(conn)
        rep = await report(pool, datetime.now(UTC).astimezone(MADRID).date(), days)
    finally:
        await pool.close()
    print(
        f"Renfe Cercanias, service days {rep.first} to {rep.last} ({rep.days_with_data} with data)"
    )
    print("error = actual arrival - time shown; bias > 0: later than shown")
    head = f"{'line':6} {'kind':10} {'horizon':>7} {'n':>7} {'MAE':>6} {'median':>6} {'p90':>6}"
    print(head + f" {'bias':>6} {'<=1m':>5} {'<=2m':>5} {'<=5m':>5}")
    for r in rep.rows:
        if r["line"] != "*" and not lines:
            continue
        if r["kind"] == "schedule":
            kind, horizon = "timetable", "-"
        else:
            kind = "live est." if r["estimated"] else "live"
            horizon = f"{r['horizon_min']} min"
        print(
            f"{r['line']:6} {kind:10} {horizon:>7} {r['n']:>7} {r['mae_s']:>5.0f}s"
            f" {r['median_abs_s']:>5.0f}s {r['p90_abs_s']:>5.0f}s {r['bias_s']:>+5.0f}s"
            f" {r['pct_1m']:>5.0%} {r['pct_2m']:>5.0%} {r['pct_5m']:>5.0%}"
        )
    if rep.provisional:
        print(
            f"provisional: a figure is final with >= {MIN_SAMPLE} matched predictions"
            f" over >= {MIN_DAYS} days (RELIABILITY_STRATEGY.md section 4)"
        )


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    parser = argparse.ArgumentParser(prog="python -m app.realtime")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run")
    sub.add_parser("once")
    cal = sub.add_parser("calibrate")
    cal.add_argument("--days", type=int, default=7)
    acc = sub.add_parser("accuracy")
    acc.add_argument("--days", type=int, default=7)
    acc.add_argument("--lines", action="store_true", help="also one row per line")
    args = parser.parse_args()
    if args.cmd == "run":
        asyncio.run(cmd_run())
    elif args.cmd == "once":
        asyncio.run(cmd_once())
    elif args.cmd == "accuracy":
        asyncio.run(cmd_accuracy(args.days, args.lines))
    else:
        asyncio.run(cmd_calibrate(args.days))


if __name__ == "__main__":
    main()
