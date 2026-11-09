"""OpenTripPlanner client: one GraphQL query (`planConnection`) and its error handling.

OTP finds the itineraries. Everything MadridGo says about them (live or scheduled, transfer
labels, provenance) is added afterwards in app/journeys.py, because OTP applies real-time
updates without telling how old they are.
"""

import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)

# Notes on the fields:
# - `intermediatePlaces` rather than `stopCalls`: OTP 2.10 cannot build stop calls for
#   frequency-based trips (EMT) and fails with "Cannot find times for Trip".
# - Agencies of expired feeds are excluded through `$exclude` (R6).
PLAN_QUERY = """
query Plan(
  $origin: PlanLabeledLocationInput!, $destination: PlanLabeledLocationInput!,
  $dateTime: PlanDateTimeInput, $first: Int, $after: String, $before: String,
  $exclude: [String!], $transferCost: Cost, $walkReluctance: Reluctance
) {
  planConnection(
    origin: $origin, destination: $destination, dateTime: $dateTime,
    first: $first, after: $after, before: $before,
    preferences: {
      transit: {
        filters: [{ exclude: [{ routes: $exclude }] }]
        transfer: { cost: $transferCost }
      }
      street: { walk: { reluctance: $walkReluctance } }
    }
  ) {
    searchDateTime
    routingErrors { code description }
    pageInfo { startCursor endCursor hasNextPage hasPreviousPage searchWindowUsed }
    edges { node {
      start end duration numberOfTransfers walkTime walkDistance waitingTime
      legs {
        mode transitLeg duration distance headsign serviceDate interlineWithPreviousLeg
        from { name lat lon stop { gtfsId code platformCode parentStation { gtfsId } } }
        to { name lat lon stop { gtfsId code platformCode parentStation { gtfsId } } }
        start { scheduledTime estimated { time delay } }
        end { scheduledTime estimated { time delay } }
        route { gtfsId shortName longName type color textColor agency { gtfsId } }
        trip { gtfsId tripHeadsign }
        intermediatePlaces {
          name stop { gtfsId } arrival { scheduledTime } departure { scheduledTime }
        }
      }
    } }
  }
}
"""


class OtpUnavailable(Exception):  # noqa: N818 - reads better at the call site
    """OTP did not answer usefully (down, timed out, or returned errors without data)."""


@dataclass
class OtpClient:
    http: httpx.AsyncClient
    base_url: str
    timeout_s: float

    async def plan(self, variables: dict[str, Any]) -> dict[str, Any]:
        """Run the plan query and return `data.planConnection`."""
        url = f"{self.base_url.rstrip('/')}/otp/gtfs/v1"
        try:
            resp = await self.http.post(
                url, json={"query": PLAN_QUERY, "variables": variables}, timeout=self.timeout_s
            )
        except httpx.HTTPError as exc:
            log.warning("OTP request failed: %s", type(exc).__name__)
            raise OtpUnavailable(type(exc).__name__) from exc
        if resp.status_code != 200:
            log.warning("OTP answered HTTP %s", resp.status_code)
            raise OtpUnavailable(f"HTTP {resp.status_code}")
        body = resp.json()
        data = (body.get("data") or {}).get("planConnection")
        if body.get("errors"):
            # Field errors on single legs still come with data; a broken query has none.
            log.warning("OTP errors: %s", [e.get("message") for e in body["errors"]][:3])
        if data is None:
            raise OtpUnavailable("no data")
        return dict(data)


_client: OtpClient | None = None
_http: httpx.AsyncClient | None = None


def get_otp() -> OtpClient:
    global _client, _http
    if _client is None:
        settings = get_settings()
        _http = httpx.AsyncClient()
        _client = OtpClient(http=_http, base_url=settings.otp_url, timeout_s=settings.otp_timeout_s)
    return _client


async def close_otp() -> None:
    global _client, _http
    if _http is not None:
        await _http.aclose()
    _client = _http = None
