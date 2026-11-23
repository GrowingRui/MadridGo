"""Request log without personal data.

uvicorn's own access log is switched off (``--no-access-log`` in the Dockerfile): it writes the
full URL, and ``/stops/nearby?lat=..&lon=..`` would put a person's location in the log next to
their IP address. This middleware logs only the method, the path (no query string), the status
and the duration. It never sees or writes the client address.
"""

import logging
import sys
import time

from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger("madridgo.access")


def setup_access_log() -> None:
    """Send the access log to stderr at INFO, once (idempotent)."""
    if logger.handlers:
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False


class AccessLogMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        start = time.perf_counter()
        status = 500

        async def send_wrapper(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            logger.info(
                "%s %s %d %.0fms",
                scope["method"],
                scope["path"],
                status,
                (time.perf_counter() - start) * 1000,
            )
