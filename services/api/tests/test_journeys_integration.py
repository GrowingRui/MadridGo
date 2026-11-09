"""`/journeys` against the real database and OTP (Phase 4 exit: p95 < 3 s).

Needs the compose stack with the `otp` profile running and the real feeds imported:
    MADRIDGO_INTEGRATION=1 pytest tests/test_journeys_integration.py
Skipped when OTP is not reachable.
"""

import os
import statistics
import time
from collections.abc import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.realtime.cache import MemoryKV
from app.realtime.service import Realtime, get_realtime


def _otp_up() -> bool:
    try:
        return httpx.get(f"{get_settings().otp_url}/otp/", timeout=2).status_code == 200
    except httpx.HTTPError:
        return False


pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(os.getenv("MADRIDGO_INTEGRATION") != "1", reason="needs docker compose"),
]

# (from, to) pairs across modes: Cercanías, interurban and urban buses, EMT, Metro Ligero.
PAIRS = [
    ({"from": "crtm:par_8_16825"}, {"to": "renfe:18000"}),  # Parla -> Atocha
    ({"from_lat": 40.4168, "from_lon": -3.7038}, {"to_lat": 40.4531, "to_lon": -3.6883}),
    ({"from_lat": 40.4381, "from_lon": -3.6795}, {"to_lat": 40.3923, "to_lon": -3.6987}),
    ({"from_lat": 40.4893, "from_lon": -3.6826}, {"to_lat": 40.4155, "to_lon": -3.7074}),
    ({"from_lat": 40.3270, "from_lon": -3.7637}, {"to_lat": 40.4240, "to_lon": -3.7120}),
    ({"from_lat": 40.4486, "from_lon": -3.7230}, {"to_lat": 40.4002, "to_lon": -3.6716}),
    ({"from_lat": 40.5470, "from_lon": -3.6420}, {"to_lat": 40.4066, "to_lon": -3.6894}),
    ({"from_lat": 40.4637, "from_lon": -3.8150}, {"to_lat": 40.4203, "to_lon": -3.7058}),
]


@pytest.fixture(scope="module")
def client() -> Iterator[TestClient]:
    if not _otp_up():
        pytest.skip("OTP is not running (docker compose --profile otp up -d otp)")
    # Live sources are covered elsewhere; keep this test about routing.
    app.dependency_overrides[get_realtime] = lambda: Realtime(kv=MemoryKV(), emt_service=None)
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_parla_to_atocha_by_cercanias(client: TestClient) -> None:
    resp = client.get("/journeys", params={"from": "crtm:par_8_16825", "to": "renfe:18000"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    lines = {lg["line"]["short_name"] for j in body["journeys"] for lg in j["legs"] if lg["line"]}
    assert lines & {"C4a", "C4b"}
    # R6: Metro's timetable is expired, so no Metro leg anywhere.
    assert not any(
        lg["line"]["source"] == "metro" for j in body["journeys"] for lg in j["legs"] if lg["line"]
    )


def test_p95_under_3_seconds(client: TestClient) -> None:
    for a, b in PAIRS[:2]:  # warm OTP up, as a running server would be
        client.get("/journeys", params={**a, **b})
    timings = []
    for _ in range(3):
        for a, b in PAIRS:
            t0 = time.perf_counter()
            resp = client.get("/journeys", params={**a, **b})
            timings.append(time.perf_counter() - t0)
            assert resp.status_code == 200, resp.text
    p95 = statistics.quantiles(timings, n=20)[18]
    median = statistics.median(timings)
    print(f"/journeys, {len(timings)} requests: median {median:.2f} s, p95 {p95:.2f} s")
    assert p95 < 3.0
