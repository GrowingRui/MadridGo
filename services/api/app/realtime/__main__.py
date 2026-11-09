"""Real-time worker CLI.

python -m app.realtime run          poll Renfe (30 s) and alerts (2 min) forever
python -m app.realtime once         one poll of every feed, print a summary
python -m app.realtime calibrate    suggest freshness thresholds from adapter_health
"""

import argparse
import asyncio
import json
import logging
from dataclasses import asdict

import asyncpg
import httpx

from app.config import get_settings
from app.db import create_pool, migrate
from app.realtime import renfe
from app.realtime.cache import close_kv, get_kv
from app.realtime.freshness import THRESHOLDS
from app.realtime.service import USER_AGENT
from app.realtime.worker import Worker, calibrate, make_upstreams, record_health, run_forever

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


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    parser = argparse.ArgumentParser(prog="python -m app.realtime")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run")
    sub.add_parser("once")
    cal = sub.add_parser("calibrate")
    cal.add_argument("--days", type=int, default=7)
    args = parser.parse_args()
    if args.cmd == "run":
        asyncio.run(cmd_run())
    elif args.cmd == "once":
        asyncio.run(cmd_once())
    else:
        asyncio.run(cmd_calibrate(args.days))


if __name__ == "__main__":
    main()
