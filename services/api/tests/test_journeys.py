"""Journey API contract and reliability tests (Phase 4).

OTP answers are real `planConnection` responses recorded from the local stack on
2026-11-09 (tests/fixtures/otp/), replayed through an httpx mock transport. The database
and live sources are replaced by fakes, so these tests need no docker.
"""

import copy
import json
from collections.abc import Callable, Iterator
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.boarding import TripStop
from app.journeys import FeedInfo, Place, get_clock, get_static, headway_for
from app.main import app
from app.otp import PLAN_QUERY, OtpClient, get_otp
from app.realtime.cache import MemoryKV
from app.realtime.emt import EmtArrivalsService
from app.realtime.models import EmtArrival, EmtArrivals, FeedSnapshot
from app.realtime.service import Realtime, get_realtime
from app.timetable import MADRID
from app.transfers import TransferSide, assess, label_for_margin, worst
from tests.realtime_helpers import snapshot

FIXTURES = Path(__file__).parent / "fixtures" / "otp"
RECORDED = datetime(2026, 11, 9, 20, 36, 20, tzinfo=MADRID)
PARLA_STOP = "crtm:par_8_16825"
ATOCHA = "renfe:18000"
C4A_TRIP = "1012L27301C4a"  # Parla 21:03 -> Atocha 21:31 in parla_atocha.json
C3_TRIP = "1012L27077C3"  # Sol 20:38 -> Nuevos Ministerios 20:43 in sol_bernabeu.json
S10 = ("emt", "FE8810069")  # frequency-based EMT trip in sol_bernabeu.json


def load(name: str) -> dict[str, Any]:
    body = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
    body.pop("_meta")
    return body


def at(hh: int, mm: int, ss: int = 0) -> datetime:
    return datetime(2026, 11, 9, hh, mm, ss, tzinfo=MADRID)


# ---------------------------------------------------------------------------
# Fakes


class FakeStatic:
    def __init__(
        self,
        expired_routes: dict[str, list[str]] | None = None,
        frequencies: dict[tuple[str, str], list[tuple[int, int, int]]] | None = None,
        termini: dict[tuple[str, str], str] | None = None,
        trip_stops: dict[tuple[str, str], list[TripStop]] | None = None,
    ) -> None:
        self.expired_routes = expired_routes or {}
        self.stops_of_trips = trip_stops or {}
        self.termini_names = termini or {}
        self.termini_asked: list[tuple[str, str]] = []
        self.windows = frequencies if frequencies is not None else {S10: [(64800, 86400, 240)]}

    async def place(self, stop_id: str) -> Place:
        places = {
            PARLA_STOP: Place(
                name="Av. Leguario - Luis Chamizo", stop_id=PARLA_STOP, lat=40.2252, lon=-3.7745
            ),
            ATOCHA: Place(
                name="Madrid - Atocha Cercanías", stop_id=ATOCHA, lat=40.4066, lon=-3.6894
            ),
        }
        if stop_id not in places:
            raise HTTPException(status_code=404, detail="Stop not found")
        return places[stop_id]

    async def feeds(self, today: date) -> FeedInfo:
        ends: dict[str, date | None] = {
            "cercanias": date(2026, 12, 13),
            "urban": date(2027, 6, 30),
            "interurban": date(2027, 6, 30),
            "emt": date(2027, 6, 30),
        }
        for feed in self.expired_routes:
            ends[feed] = date(2026, 5, 27)
        return FeedInfo(service_end=ends, route_ids=self.expired_routes)

    async def frequencies(
        self, trips: list[tuple[str, str]]
    ) -> dict[tuple[str, str], list[tuple[int, int, int]]]:
        return {t: self.windows[t] for t in trips if t in self.windows}

    async def termini(self, trips: list[tuple[str, str]]) -> dict[tuple[str, str], str]:
        self.termini_asked += trips
        return {t: self.termini_names[t] for t in trips if t in self.termini_names}

    async def nearest_stop(self, lat: float, lon: float) -> tuple[float, float] | None:
        return None

    async def trip_stops(
        self, trips: list[tuple[str, str]]
    ) -> dict[tuple[str, str], list[TripStop]]:
        return {t: self.stops_of_trips[t] for t in trips if t in self.stops_of_trips}


class FakeOtp:
    """Replays a recorded answer and keeps the variables of each request."""

    def __init__(self, body: dict[str, Any] | Callable[[httpx.Request], httpx.Response]) -> None:
        self.requests: list[dict[str, Any]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            self.requests.append(payload)
            if callable(body):
                return body(request)
            return httpx.Response(200, json=body)

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.client = OtpClient(http=http, base_url="http://otp:8080", timeout_s=5)

    @property
    def variables(self) -> dict[str, Any]:
        return dict(self.requests[-1]["variables"])


class EmtFake:
    def __init__(self, arrivals: list[EmtArrival], retrieved: datetime) -> None:
        self.calls: list[str] = []
        self.arrivals, self.retrieved = arrivals, retrieved

    async def __call__(self, stop_code: str) -> EmtArrivals:
        self.calls.append(stop_code)
        return EmtArrivals(
            stop_code=stop_code,
            retrieved_at=self.retrieved,
            server_time=None,
            arrivals=self.arrivals,
        )


def realtime(snap: FeedSnapshot | None = None, emt: EmtFake | None = None) -> Realtime:
    kv = MemoryKV()
    rt = Realtime(kv=kv, emt_service=None)
    if snap is not None:

        async def renfe_snapshot() -> FeedSnapshot:
            return snap

        rt.renfe_snapshot = renfe_snapshot  # type: ignore[method-assign]
    if emt is not None:
        rt.emt_service = EmtArrivalsService(kv=kv, fetch=emt, wallclock=lambda: emt.retrieved)
    return rt


@pytest.fixture
def setup() -> Iterator[Callable[..., TestClient]]:
    def configure(
        otp: FakeOtp,
        static: FakeStatic | None = None,
        rt: Realtime | None = None,
        now: datetime = RECORDED,
    ) -> TestClient:
        app.dependency_overrides[get_otp] = lambda: otp.client
        app.dependency_overrides[get_static] = lambda: static or FakeStatic()
        app.dependency_overrides[get_realtime] = lambda: rt or realtime()
        app.dependency_overrides[get_clock] = lambda: lambda: now
        return TestClient(app)

    yield configure
    app.dependency_overrides.clear()


def plan(client: TestClient, **params: Any) -> dict[str, Any]:
    params.setdefault("from", PARLA_STOP)
    params.setdefault("to", ATOCHA)
    resp = client.get("/journeys", params=params)
    assert resp.status_code == 200, resp.text
    return dict(resp.json())


SOL = {"from_lat": 40.4168, "from_lon": -3.7038, "to_lat": 40.4531, "to_lon": -3.6883}


# ---------------------------------------------------------------------------
# Contract: request sent to OTP and shape of the answer


def test_request_to_otp(setup: Callable[..., TestClient]) -> None:
    otp = FakeOtp(load("parla_atocha"))
    client = setup(otp, FakeStatic(expired_routes={"metro": ["4__1___", "4__2___"]}))
    plan(client, at="2026-11-09T20:36:20", limit=4)
    sent = otp.requests[-1]
    assert sent["query"] == PLAN_QUERY
    v = otp.variables
    assert v["origin"]["location"]["coordinate"] == {"latitude": 40.2252, "longitude": -3.7745}
    assert v["origin"]["label"] == "Av. Leguario - Luis Chamizo"
    assert v["dateTime"] == {"earliestDeparture": "2026-11-09T20:36:20+01:00"}  # naive = Madrid
    assert v["first"] == 4
    assert v["exclude"] == ["metro:4__1___", "metro:4__2___"]  # R6: expired feed not routed
    assert "after" not in v and "before" not in v


def test_recorded_parla_atocha_answer(setup: Callable[..., TestClient]) -> None:
    body = plan(setup(FakeOtp(load("parla_atocha"))))
    assert body["from"]["stop_id"] == PARLA_STOP and body["to"]["stop_id"] == ATOCHA
    assert body["routing_error"] is None and body["message"] is None
    assert body["later_cursor"].startswith("a:") and body["earlier_cursor"].startswith("b:")
    journeys = body["journeys"]
    assert len(journeys) == 5
    arrivals = [j["arrival"]["scheduled"] for j in journeys]
    assert arrivals == sorted(arrivals)  # default sort: earliest arrival

    j = journeys[0]  # walk, urban bus 1, walk, C4a
    assert [lg["mode"] for lg in j["legs"]] == ["walk", "bus", "walk", "rail"]
    bus, rail = j["legs"][1], j["legs"][3]
    assert bus["line"]["short_name"] == "1" and bus["line"]["source"] == "urban"
    assert bus["from_stop_id"] == "crtm:par_8_16826"  # OTP feed id -> MadridGo namespace
    assert rail["from_stop_id"] == "renfe:37012" and rail["to_stop_id"] == ATOCHA
    assert rail["trip_id"] == f"cercanias:{C4A_TRIP}"
    assert rail["line"] == {
        "source": "cercanias",
        "route_id": rail["line"]["route_id"],
        "short_name": "C4a",
        "long_name": rail["line"]["long_name"],
        "mode": "rail",
        "color": "2C2A86",
        "text_color": "FFFFFF",
    }
    assert rail["from"] == "Parla" and rail["to"] == "Madrid - Atocha Cercanías"
    assert j["legs"][0]["from"] == "Av. Leguario - Luis Chamizo"  # the chosen stop's name
    assert len(rail["intermediate"]) >= 3
    assert rail["departure"]["scheduled"] == "2026-11-09T21:03:00+01:00"
    # Nothing live without a live source: every time is scheduled and says so.
    for lg in j["legs"]:
        for t in (lg["departure"], lg["arrival"]):
            assert t["status"] == "scheduled" and t["estimated"] is None and t["realtime"] is None
    assert j["data_quality"] == "scheduled"
    assert j["transfers"] == 1 and j["is_preview"] is False and j["feasible"] is True
    assert j["duration_min"] == 50  # 20:40:49 -> 21:31
    assert j["walk_min"] == round((73 + 683) / 60)


def test_route_map_geometry_and_coordinates(setup: Callable[..., TestClient]) -> None:
    """The route map draws each leg's OTP shape and puts dots on its stops."""
    raw = load("parla_atocha")
    rail = raw["data"]["planConnection"]["edges"][0]["node"]["legs"][3]
    rail["legGeometry"] = {"points": "_p~iF~ps|U_ulLnnqC"}
    rail["intermediatePlaces"][0].update(lat=40.3, lon=-3.75)
    j = plan(setup(FakeOtp(raw)))["journeys"][0]
    walk, rail_leg = j["legs"][0], j["legs"][3]
    assert rail_leg["geometry"] == "_p~iF~ps|U_ulLnnqC"
    assert rail_leg["intermediate"][0]["lat"] == 40.3
    assert rail_leg["intermediate"][0]["lon"] == -3.75
    assert walk["geometry"] is None  # no shape in the recording: the app draws a straight line
    for lg in j["legs"]:
        assert lg["from_lat"] is not None and lg["to_lon"] is not None


def test_walk_only_option_is_dropped_when_transit_is_faster(
    setup: Callable[..., TestClient],
) -> None:
    body = plan(setup(FakeOtp(load("sol_bernabeu"))), **{"from": None, "to": None, **SOL})
    assert all(any(lg["mode"] != "walk" for lg in j["legs"]) for j in body["journeys"])
    assert body["from"]["name"] == "Your location" and body["from"]["stop_id"] is None


def test_point_named_by_the_app(setup: Callable[..., TestClient]) -> None:
    """An address chosen in the search keeps its name (not "Your location")."""
    otp = FakeOtp(load("sol_bernabeu"))
    body = plan(
        setup(otp),
        **{"from": None, "to": None, **SOL, "from_name": " Calle Mayor 5 ", "to_name": ""},
    )
    assert body["from"]["name"] == "Calle Mayor 5"
    assert otp.variables["origin"]["label"] == "Calle Mayor 5"
    assert body["to"]["name"] == "Your location"  # empty name: the default


def test_routing_error_is_explained(setup: Callable[..., TestClient]) -> None:
    body = plan(setup(FakeOtp(load("outside_service"))), at="2027-09-01T08:00:00")
    assert body["routing_error"] == "OUTSIDE_SERVICE_PERIOD"
    assert body["message"] == "There is no timetable for this date yet."
    assert all(lg["mode"] == "walk" for j in body["journeys"] for lg in j["legs"])


def test_arrive_by_and_cursors(setup: Callable[..., TestClient]) -> None:
    otp = FakeOtp(load("parla_atocha"))
    client = setup(otp)
    plan(client, at="2026-11-10T09:00:00+01:00", arrive_by="true")
    assert otp.variables["dateTime"] == {"latestArrival": "2026-11-10T09:00:00+01:00"}
    plan(client, cursor="a:NEXT")
    assert otp.variables["after"] == "NEXT" and "dateTime" not in otp.variables
    plan(client, cursor="b:PREV")
    assert otp.variables["before"] == "PREV"
    assert (
        client.get(
            "/journeys", params={"from": PARLA_STOP, "to": ATOCHA, "cursor": "x"}
        ).status_code
        == 422
    )


def test_bad_requests(setup: Callable[..., TestClient]) -> None:
    client = setup(FakeOtp(load("parla_atocha")))
    assert client.get("/journeys", params={"from": PARLA_STOP}).status_code == 422
    assert client.get("/journeys", params={"from": "nope:1", "to": ATOCHA}).status_code == 404
    out_of_area = {"from_lat": 48.85, "from_lon": 2.35, "to_lat": 40.41, "to_lon": -3.69}
    assert client.get("/journeys", params=out_of_area).status_code == 422


@pytest.mark.parametrize(
    "answer",
    [
        lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused", request=r)),
        lambda r: httpx.Response(500, text="boom"),
        lambda r: httpx.Response(200, json={"errors": [{"message": "Validation error"}]}),
    ],
    ids=["down", "http-500", "graphql-error"],
)
def test_otp_failure_gives_503(
    setup: Callable[..., TestClient], answer: Callable[[httpx.Request], httpx.Response]
) -> None:
    resp = setup(FakeOtp(answer)).get("/journeys", params={"from": PARLA_STOP, "to": ATOCHA})
    assert resp.status_code == 503
    assert "unavailable" in resp.json()["detail"]


def test_sort_options(setup: Callable[..., TestClient]) -> None:
    otp = FakeOtp(load("parla_atocha"))
    client = setup(otp)
    body = plan(client, sort="fewest_transfers")
    assert otp.variables["transferCost"] == 600
    transfers = [j["transfers"] for j in body["journeys"]]
    assert transfers == sorted(transfers) and transfers[0] == 0
    body = plan(client, sort="least_walking")
    assert otp.variables["walkReluctance"] == 5.0
    walks = [j["walk_min"] for j in body["journeys"]]
    assert walks == sorted(walks)
    body = plan(client, sort="fastest")
    durations = [j["duration_min"] for j in body["journeys"]]
    assert durations == sorted(durations)


def test_otp_returns_the_same_itinerary_twice(setup: Callable[..., TestClient]) -> None:
    body = load("parla_atocha")
    edges = body["data"]["planConnection"]["edges"]
    edges.append(copy.deepcopy(edges[0]))
    assert len(plan(setup(FakeOtp(body)))["journeys"]) == 5


# ---------------------------------------------------------------------------
# R6 Expired timetable: never routed


def test_r6_itinerary_on_an_expired_feed_is_dropped(setup: Callable[..., TestClient]) -> None:
    body = load("parla_atocha")
    leg = body["data"]["planConnection"]["edges"][2]["node"]["legs"][1]
    leg["route"]["gtfsId"] = "metro:4__1___"  # pretend OTP still found a Metro journey
    leg["route"]["agency"]["gtfsId"] = "metro:CRTM"
    result = plan(setup(FakeOtp(body), FakeStatic(expired_routes={"metro": ["4__1___"]})))
    assert len(result["journeys"]) == 4
    assert all(
        lg["line"]["source"] != "metro"
        for j in result["journeys"]
        for lg in j["legs"]
        if lg["line"]
    )
    notice = next(n for n in result["notices"] if n["source"] == "metro")
    assert notice["expiry"] == "expired"
    assert "not used in these journeys" in notice["message"]


# ---------------------------------------------------------------------------
# Transfer labels on recorded journeys


def test_bus_to_train_changes_on_the_timetable(setup: Callable[..., TestClient]) -> None:
    by_line = {
        j["legs"][1]["line"]["short_name"]: j
        for j in plan(setup(FakeOtp(load("parla_atocha"))))["journeys"]
        if j["transfers"]
    }
    # Bus 1 arrives 20:48:16, 11:23 walk, C4a leaves 21:03: 3:21 spare - 2 min bus allowance.
    c1 = by_line["1"]["changes"][0]
    assert (c1["label"], c1["margin_min"], c1["basis"]) == ("at_risk", 1, "scheduled")
    assert c1["from_leg"] == 1 and c1["to_leg"] == 3 and c1["walk_min"] == 11
    assert c1["at"] == "Real - Olivo"
    # Bus 2 arrives 21:06:37, 7:08 walk, C4a 21:23: 9:15 - 2:00 = 7:15.
    assert by_line["2"]["changes"][0]["label"] == "comfortable"
    assert by_line["2"]["reliability"] == "comfortable"
    assert by_line["461"]["changes"][0]["label"] == "at_risk"


def test_r13_change_onto_a_frequency_service(setup: Callable[..., TestClient]) -> None:
    body = plan(setup(FakeOtp(load("sol_bernabeu"))), **{"from": None, "to": None, **SOL})
    j = next(j for j in body["journeys"] if len(j["legs"]) == 5)
    bus = j["legs"][3]
    assert bus["line"]["short_name"] == "S10"
    assert bus["headway_min"] == 4
    assert bus["departure"]["status"] == "frequency" and bus["arrival"]["status"] == "frequency"
    change = j["changes"][0]
    assert change["label"] is None and change["wait_up_to_min"] == 4
    assert "wait up to 4 min" in change["message"]
    assert j["reliability"] is None
    # The trip ends on the frequency leg's walk: approximate, so not "scheduled".
    assert j["arrival"]["status"] == "frequency"


def test_headway_window_selection() -> None:
    windows = [(7 * 3600, 10 * 3600, 300), (10 * 3600, 21 * 3600, 600), (21 * 3600, 26 * 3600, 900)]
    day = date(2026, 11, 9)
    assert headway_for(windows, day, at(8, 0)) == 5
    assert headway_for(windows, day, at(21, 30)) == 15
    assert headway_for(windows, day, at(6, 0)) == 5  # before the first window: the first


# ---------------------------------------------------------------------------
# Live data on journey legs (Renfe GTFS-RT)


def _sol_snapshot(header: datetime, delay_s: int = 420) -> FeedSnapshot:
    return snapshot(
        header,
        header,
        [
            {
                "trip_id": C3_TRIP,
                "stop_id": "18101",
                "time": at(20, 38) + timedelta(seconds=delay_s),
                "delay": delay_s,
            }
        ],
    )


def test_live_delay_moves_the_walks_with_the_train(setup: Callable[..., TestClient]) -> None:
    rt = realtime(_sol_snapshot(RECORDED - timedelta(seconds=10)))
    body = plan(setup(FakeOtp(load("sol_bernabeu")), rt=rt), **{"from": None, "to": None, **SOL})
    j = next(
        j
        for j in body["journeys"]
        if len(j["legs"]) == 3 and j["legs"][1]["line"]["short_name"] == "C3"
    )
    train = j["legs"][1]
    assert train["departure"]["status"] == "live"
    assert train["departure"]["scheduled"] == "2026-11-09T20:38:00+01:00"
    assert train["departure"]["estimated"] == "2026-11-09T20:45:00+01:00"
    assert train["departure"]["realtime"]["source"] == "renfe_gtfsrt"
    assert train["departure"]["realtime"]["delay_s"] == 420
    assert train["arrival"]["estimated"] == "2026-11-09T20:50:00+01:00"
    assert train["arrival"]["realtime"]["estimated_from_trip_delay"] is True
    # OTP planned the walk to Sol against the delayed train (20:42:59-20:45). It is shown
    # against the timetable, with the live estimate next to it, not shifted twice.
    assert j["departure"]["scheduled"] == "2026-11-09T20:35:59+01:00"
    assert j["departure"]["estimated"] == "2026-11-09T20:42:59+01:00"
    assert j["arrival"]["scheduled"] == "2026-11-09T21:00:26+01:00"
    assert j["arrival"]["estimated"] == "2026-11-09T21:07:26+01:00"
    assert j["duration_min"] == 24
    assert j["data_quality"] == "partly_live"
    assert body["realtime"][0]["feed"] == "cercanias" and body["realtime"][0]["status"] == "live"


def test_without_live_data_otp_delays_are_not_shown(setup: Callable[..., TestClient]) -> None:
    """OTP applied a +7 delay itself, but MadridGo has no fresh data: show the timetable."""
    body = plan(setup(FakeOtp(load("sol_bernabeu"))), **{"from": None, "to": None, **SOL})
    for j in body["journeys"]:
        for lg in j["legs"]:
            assert lg["departure"]["status"] in ("scheduled", "frequency")
    c3 = next(
        j
        for j in body["journeys"]
        if len(j["legs"]) == 3 and j["legs"][1]["line"]["short_name"] == "C3"
    )
    assert c3["departure"]["scheduled"] == "2026-11-09T20:35:59+01:00"
    assert c3["departure"]["estimated"] is None
    status = body["realtime"][0]
    assert status["feed"] == "cercanias" and status["status"] == "unavailable"


def test_r4_stale_renfe_data_is_never_shown_live(setup: Callable[..., TestClient]) -> None:
    rt = realtime(_sol_snapshot(RECORDED - timedelta(minutes=10)))
    body = plan(setup(FakeOtp(load("sol_bernabeu")), rt=rt), **{"from": None, "to": None, **SOL})
    assert all(
        t["status"] != "live"
        for j in body["journeys"]
        for lg in j["legs"]
        for t in (lg["departure"], lg["arrival"])
    )
    assert body["realtime"][0]["status"] == "stale"


def test_r2_cancelled_train_makes_the_journey_not_feasible(
    setup: Callable[..., TestClient],
) -> None:
    snap = snapshot(RECORDED, RECORDED, [{"trip_id": C4A_TRIP, "cancelled": True}])
    body = plan(setup(FakeOtp(load("parla_atocha")), rt=realtime(snap)))
    affected = [
        j
        for j in body["journeys"]
        if any(lg["trip_id"] == f"cercanias:{C4A_TRIP}" for lg in j["legs"])
    ]
    assert len(affected) == 1
    j = affected[0]
    assert j["feasible"] is False
    assert j["issues"] == [
        "C4a 21:03 from Parla is cancelled.",
        "Change at Real - Olivo: The connecting trip is cancelled.",
    ]
    rail = j["legs"][3]
    assert (
        rail["departure"]["status"] == "cancelled"
        and rail["departure"]["realtime"]["classification"] == "CANCELLED"
    )
    assert j["changes"][0]["label"] == "not_feasible"
    assert j["reliability"] == "not_feasible"
    # Alternatives are offered first; the cancelled one stays visible, last.
    assert body["journeys"][-1]["id"] == j["id"]
    assert all(x["feasible"] for x in body["journeys"][:-1])


def test_train_that_already_passed_the_boarding_stop(setup: Callable[..., TestClient]) -> None:
    # The feed's next stop for this train is Atocha: it is already past Parla.
    snap = snapshot(
        RECORDED,
        RECORDED,
        [{"trip_id": C4A_TRIP, "stop_id": "18000", "time": at(21, 31), "delay": 0}],
    )
    body = plan(setup(FakeOtp(load("parla_atocha")), rt=realtime(snap)))
    j = next(
        j
        for j in body["journeys"]
        if any(lg["trip_id"] == f"cercanias:{C4A_TRIP}" for lg in j["legs"])
    )
    assert j["feasible"] is False and j["issues"] == ["C4a 21:03 has already left Parla."]


def test_live_data_is_not_matched_to_another_day(setup: Callable[..., TestClient]) -> None:
    """Renfe trip IDs repeat every day: a delay today must not appear on tomorrow's trip."""
    snap = _sol_snapshot(RECORDED + timedelta(days=1) - timedelta(seconds=10))
    rt = realtime(snap)
    body = plan(
        setup(FakeOtp(load("sol_bernabeu")), rt=rt, now=RECORDED + timedelta(days=1)),
        **{"from": None, "to": None, **SOL},
    )
    assert all(lg["departure"]["status"] != "live" for j in body["journeys"] for lg in j["legs"])


# ---------------------------------------------------------------------------
# R1 / R10: a live delay recomputes the change label


def _node(rail_dep: datetime, rail_arr: datetime, walk_s: int, bus_dep: datetime) -> dict[str, Any]:
    """A minimal OTP itinerary: C4a Parla -> Atocha, walk, interurban bus from Atocha."""

    def t(x: datetime) -> dict[str, Any]:
        return {"scheduledTime": x.isoformat(), "estimated": None}

    def place(name: str, stop: str | None) -> dict[str, Any]:
        return {"name": name, "lat": 40.4, "lon": -3.7, "stop": {"gtfsId": stop} if stop else None}

    bus_arr = bus_dep + timedelta(minutes=20)
    return {
        "legs": [
            {
                "mode": "RAIL",
                "transitLeg": True,
                "duration": (rail_arr - rail_dep).seconds,
                "distance": 20000.0,
                "headsign": "Alcobendas",
                "serviceDate": "2026-11-09",
                "interlineWithPreviousLeg": False,
                "from": place("Parla", "cercanias:37012"),
                "to": place("Atocha", "cercanias:18000"),
                "start": t(rail_dep),
                "end": t(rail_arr),
                "route": {
                    "gtfsId": "cercanias:10T0014C4a",
                    "shortName": "C4a",
                    "longName": None,
                    "type": 2,
                    "color": "2C2A86",
                    "textColor": "FFFFFF",
                    "agency": None,
                },
                "trip": {"gtfsId": f"cercanias:{C4A_TRIP}", "tripHeadsign": "Alcobendas"},
                "intermediatePlaces": [],
            },
            {
                "mode": "WALK",
                "transitLeg": False,
                "duration": walk_s,
                "distance": 300.0,
                "from": place("Atocha", "cercanias:18000"),
                "to": place("Atocha bus", "interurban:par_8_1"),
                "start": t(rail_arr),
                "end": t(rail_arr + timedelta(seconds=walk_s)),
                "route": None,
                "trip": None,
            },
            {
                "mode": "BUS",
                "transitLeg": True,
                "duration": 1200,
                "distance": 9000.0,
                "headsign": "Getafe",
                "serviceDate": "2026-11-09",
                "interlineWithPreviousLeg": False,
                "from": place("Atocha bus", "interurban:par_8_1"),
                "to": place("Getafe", "interurban:par_8_2"),
                "start": t(bus_dep),
                "end": t(bus_arr),
                "route": {
                    "gtfsId": "interurban:8__447___",
                    "shortName": "447",
                    "longName": None,
                    "type": 3,
                    "color": "8EBF42",
                    "textColor": "FFFFFF",
                    "agency": None,
                },
                "trip": {"gtfsId": "interurban:447-1", "tripHeadsign": "Getafe"},
                "intermediatePlaces": [],
            },
        ]
    }


def _plan_body(node: dict[str, Any]) -> dict[str, Any]:
    return {
        "data": {
            "planConnection": {
                "searchDateTime": RECORDED.isoformat(),
                "routingErrors": [],
                "pageInfo": {"hasNextPage": False, "hasPreviousPage": False},
                "edges": [{"node": node}],
            }
        }
    }


@pytest.mark.parametrize(
    ("delay_min", "label", "feasible"),
    [
        (None, "comfortable", True),
        (0, "comfortable", True),
        (7, "tight", True),
        (9, "at_risk", True),
        (12, "not_feasible", False),
    ],
)
def test_r1_r10_live_delay_recomputes_the_change(
    setup: Callable[..., TestClient], delay_min: int | None, label: str, feasible: bool
) -> None:
    # C4a 21:03 -> 21:31, 5 min walk, bus at 21:45. Timetable: 9 min spare - 1 min rail
    # allowance = 8 (comfortable). Live +7: 2 min (tight). +9: 0 (at risk). +12: -3.
    node = _node(at(21, 3), at(21, 31), 300, at(21, 45))
    now = at(21, 0)
    snap = None
    if delay_min is not None:
        d = delay_min * 60
        snap = snapshot(
            now - timedelta(seconds=10),
            now,
            [
                {
                    "trip_id": C4A_TRIP,
                    "stop_id": "37012",
                    "time": at(21, 3) + timedelta(seconds=d),
                    "delay": d,
                }
            ],
        )
    body = plan(setup(FakeOtp(_plan_body(node)), rt=realtime(snap), now=now))
    j = body["journeys"][0]
    change = j["changes"][0]
    assert change["label"] == label
    assert change["basis"] == ("scheduled" if delay_min is None else "live")
    assert j["feasible"] is feasible
    if delay_min:
        assert (
            j["legs"][0]["arrival"]["estimated"]
            == (at(21, 31) + timedelta(minutes=delay_min)).isoformat()
        )
    if not feasible:
        assert "running late" in j["issues"][0]


# ---------------------------------------------------------------------------
# EMT live overlay


def test_emt_leg_boards_the_first_live_bus_you_can_reach(setup: Callable[..., TestClient]) -> None:
    emt = EmtFake(
        [
            EmtArrival(
                line="S10", destination="Bernabéu", seconds=300, vehicle_id="1", distance_m=900
            ),
            EmtArrival(
                line="27",
                destination="Plaza Castilla",
                seconds=420,
                vehicle_id="2",
                distance_m=1200,
            ),
            EmtArrival(
                line="S10", destination="Bernabéu", seconds=900, vehicle_id="3", distance_m=2600
            ),
        ],
        RECORDED,
    )
    body = plan(
        setup(FakeOtp(load("sol_bernabeu")), rt=realtime(emt=emt)),
        **{"from": None, "to": None, **SOL},
    )
    assert emt.calls == ["2696"]  # one call for the stop, shared by both journeys
    j = next(
        j
        for j in body["journeys"]
        if len(j["legs"]) == 5 and j["legs"][1]["line"]["short_name"] == "C3"
    )
    bus = j["legs"][3]
    # C3 arrives 20:43 + 2:18 walk = 20:45:18: the S10 at 20:41:20 is gone, take 20:51:20.
    assert bus["departure"]["status"] == "live"
    assert bus["departure"]["estimated"] == "2026-11-09T20:51:20+01:00"
    info = bus["departure"]["realtime"]
    assert info["source"] == "emt_mobilitylabs" and info["vehicle_id"] == "3"
    assert info["delay_s"] is None  # headway service: no timetable to compare with
    assert info["freshness"]["age_basis"] == "retrieved"
    assert bus["arrival"]["realtime"]["estimated_from_trip_delay"] is True
    change = j["changes"][0]  # now a specific bus: a real margin, 5:02 after the rail allowance
    assert change["label"] == "comfortable" and change["margin_min"] == 5
    emt_status = next(s for s in body["realtime"] if s["feed"] == "emt")
    assert emt_status["status"] == "live"


def _bus_only_candidates(
    minutes: list[int], search: str, walk_first: bool = False
) -> dict[str, Any]:
    """OTP's answer for a frequency line: the same S10 ride offered once a minute. With
    `walk_first`, a 2-min walk to the stop at the search time, then OTP's wait."""
    body = load("sol_bernabeu")
    pc = body["data"]["planConnection"]
    template = pc["edges"][1]["node"]
    bus = template["legs"][3]
    start = datetime.fromisoformat(search)
    walk = {
        **template["legs"][0],
        "to": bus["from"],
        "start": {"scheduledTime": start.isoformat(), "estimated": None},
        "end": {"scheduledTime": (start + timedelta(minutes=2)).isoformat(), "estimated": None},
    }

    def shift(value: Any, m: int) -> Any:
        if isinstance(value, dict):
            return {k: shift(v, m) for k, v in value.items()}
        if isinstance(value, list):
            return [shift(v, m) for v in value]
        if isinstance(value, str) and value.startswith("2026-11-09T"):
            return (datetime.fromisoformat(value) + timedelta(minutes=m)).isoformat()
        return value

    edges = []
    for m in minutes:
        leg = shift(bus, m)
        legs = [walk, leg] if walk_first else [leg]
        node = {**template, "legs": legs, "start": legs[0]["start"]["scheduledTime"]}
        node["end"] = leg["end"]["scheduledTime"]
        edges.append({"node": node})
    pc["edges"], pc["searchDateTime"] = edges, search
    pc["pageInfo"] = {**(pc.get("pageInfo") or {}), "hasNextPage": True, "endCursor": "x"}
    return body


def test_emt_frequency_candidates_are_not_shown_on_one_bus(
    setup: Callable[..., TestClient],
) -> None:
    """Found 2026-11-12 (line E): OTP's once-a-minute candidates all took the same live
    bus, so one connection was listed five times. Each now takes its own bus; the rest are
    dropped as copies of a connection already listed."""
    emt = EmtFake(
        [
            EmtArrival(line="S10", destination="B", seconds=300, vehicle_id="7", distance_m=900),
            EmtArrival(line="S10", destination="B", seconds=1080, vehicle_id="8", distance_m=4000),
        ],
        RECORDED,
    )
    body = plan(
        setup(
            FakeOtp(_bus_only_candidates([0, 1, 2, 3, 4], "2026-11-09T20:36:20+01:00")),
            rt=realtime(emt=emt),
        ),
        **{"from": None, "to": None, **SOL},
    )
    buses = [j["legs"][0]["departure"] for j in body["journeys"]]
    # The two live buses, one each (20:41:20 and 20:54:20); then OTP's 21:00:18 as "every
    # ~4 min" (more than a headway after the last live bus); 21:01 and 21:02 are its copies.
    assert [b["status"] for b in buses] == ["live", "live", "frequency"]
    assert [b["realtime"]["vehicle_id"] for b in buses[:2]] == ["7", "8"]
    assert [b["estimated"] for b in buses[:2]] == [
        "2026-11-09T20:41:20+01:00",
        "2026-11-09T20:54:20+01:00",
    ]
    assert buses[2]["scheduled"] == "2026-11-09T21:00:18+01:00"


def test_emt_later_page_does_not_go_back_to_the_first_bus(
    setup: Callable[..., TestClient],
) -> None:
    emt = EmtFake(
        [EmtArrival(line="S10", destination="B", seconds=300, vehicle_id="7", distance_m=900)],
        RECORDED,
    )
    # A later page: OTP searched from 21:10, beyond the live bus at 20:41.
    body = plan(
        setup(
            FakeOtp(_bus_only_candidates([20, 21, 22], "2026-11-09T21:10:00+01:00")),
            rt=realtime(emt=emt),
        ),
        **{"from": None, "to": None, "cursor": "a:x", **SOL},
    )
    buses = [j["legs"][0]["departure"] for j in body["journeys"]]
    assert len(buses) == 1  # 21:18, 21:19 and 21:20 are one "every ~4 min" bus
    assert buses[0]["status"] == "frequency"


def test_walk_to_an_earlier_live_bus_does_not_start_before_the_search(
    setup: Callable[..., TestClient],
) -> None:
    """Found 2026-11-12: OTP walked you to the stop at the search time (20:36:20) and had
    you wait for its bus at 20:58:18. The live bus comes at 20:41:20; the walk used to move
    back with it, to 20:19, before the search. The wait covers it: the walk stays."""
    emt = EmtFake(
        [EmtArrival(line="S10", destination="B", seconds=300, vehicle_id="7", distance_m=900)],
        RECORDED,
    )
    body = plan(
        setup(
            FakeOtp(_bus_only_candidates([0], "2026-11-09T20:36:20+01:00", walk_first=True)),
            rt=realtime(emt=emt),
        ),
        **{"from": None, "to": None, **SOL},
    )
    j = body["journeys"][0]
    assert j["legs"][1]["departure"]["estimated"] == "2026-11-09T20:41:20+01:00"
    assert j["departure"]["estimated"] == "2026-11-09T20:36:20+01:00"
    assert j["legs"][0]["arrival"]["estimated"] == "2026-11-09T20:38:20+01:00"


def test_emt_earlier_page_is_not_put_on_the_first_pages_buses(
    setup: Callable[..., TestClient],
) -> None:
    """Found 2026-11-12: an "Earlier connections" page put OTP's past candidates on the live
    buses of the first page. A candidate already gone takes no live bus, nor does one whose
    bus would come long after OTP's time (that bus belongs to a later candidate)."""
    emt = EmtFake(
        [EmtArrival(line="S10", destination="B", seconds=1800, vehicle_id="7", distance_m=9000)],
        RECORDED,
    )
    # OTP's candidates at 20:28 and 20:29 (gone) and 20:58 (its bus is due by then; EMT's
    # only bus comes at 21:06, beyond 20:58 + 5 min).
    body = plan(
        setup(
            FakeOtp(_bus_only_candidates([-30, -29, 0], "2026-11-09T20:00:00+01:00")),
            rt=realtime(emt=emt),
        ),
        **{"from": None, "to": None, "cursor": "b:x", **SOL},
    )
    buses = [j["legs"][0]["departure"] for j in body["journeys"]]
    assert all(b["status"] == "frequency" for b in buses)
    # 20:28 and 20:29 are one bus; 20:58 is another.
    assert [b["scheduled"][11:16] for b in buses] == ["20:28", "20:58"]


def test_walk_between_vehicles_follows_a_late_train_and_duration_matches_the_times(
    setup: Callable[..., TestClient],
) -> None:
    """Found 2026-11-12: a train 15 min late, then a walk to a bus. The walk kept the
    timetable's time (it started before the train arrived), and the duration was taken from
    the timetable at both ends (16:08 -> 16:36 shown as 44 min)."""
    node = _node(at(21, 3), at(21, 31), 300, at(21, 45))
    now = at(21, 0)
    d = 7 * 60
    snap = snapshot(
        now - timedelta(seconds=10),
        now,
        # One update at Parla; Renfe's trip delay carries to Atocha (21:38).
        [{"trip_id": C4A_TRIP, "stop_id": "37012", "time": at(21, 10), "delay": d}],
    )
    body = plan(setup(FakeOtp(_plan_body(node)), rt=realtime(snap), now=now))
    j = body["journeys"][0]
    walk = j["legs"][1]
    assert walk["departure"]["estimated"] == at(21, 38).isoformat()
    assert walk["arrival"]["estimated"] == at(21, 43).isoformat()
    # Leaves 21:10 (live), the bus arrives 22:05 (its own timetable): 55 min, not 62.
    assert j["departure"]["estimated"] == at(21, 10).isoformat()
    assert j["arrival"]["scheduled"] == at(22, 5).isoformat()
    assert j["duration_min"] == 55


def test_emt_not_configured(setup: Callable[..., TestClient]) -> None:
    body = plan(setup(FakeOtp(load("sol_bernabeu"))), **{"from": None, "to": None, **SOL})
    status = next(s for s in body["realtime"] if s["feed"] == "emt")
    assert status["status"] == "unavailable"
    assert "not set up" in status["message"]
    j = next(j for j in body["journeys"] if len(j["legs"]) == 5)
    assert j["legs"][3]["departure"]["status"] == "frequency"


def test_emt_is_not_called_for_buses_far_ahead(setup: Callable[..., TestClient]) -> None:
    emt = EmtFake([], RECORDED)
    plan(
        setup(
            FakeOtp(load("sol_bernabeu")), rt=realtime(emt=emt), now=RECORDED - timedelta(hours=1)
        ),
        **{"from": None, "to": None, **SOL},
    )
    assert emt.calls == []


# ---------------------------------------------------------------------------
# Transfer rules (RELIABILITY_STRATEGY.md §5), unit level


def side(mode: str, t: datetime, live: bool = True, **kw: Any) -> TransferSide:
    return TransferSide(mode=mode, time=t, live=live, **kw)


@pytest.mark.parametrize(
    ("margin_s", "label"),
    [
        (300, "comfortable"),
        (299, "tight"),
        (120, "tight"),
        (119, "at_risk"),
        (0, "at_risk"),
        (-1, "not_feasible"),
    ],
)
def test_label_boundaries(margin_s: int, label: str) -> None:
    assert label_for_margin(margin_s) == label
    base = at(12, 0)
    res = assess(
        side("rail", base), side("rail", base + timedelta(seconds=margin_s + 60)), walk_s=60
    )
    assert res.label == label and res.margin_s == margin_s


def test_scheduled_bus_arrival_gets_two_minutes_allowance() -> None:
    base = at(12, 0)
    live = assess(side("bus", base), side("rail", base + timedelta(minutes=5)), walk_s=0)
    sched = assess(
        side("bus", base, live=False), side("rail", base + timedelta(minutes=5)), walk_s=0
    )
    assert (live.label, sched.label) == ("comfortable", "tight")
    assert sched.margin_s == 180


def test_cancelled_vehicles() -> None:
    base = at(12, 0)
    later = base + timedelta(minutes=20)
    assert (
        assess(side("rail", base, cancelled=True), side("rail", later), 0).label == "not_feasible"
    )
    assert assess(side("rail", base), side("bus", later, cancelled=True), 0).label == "not_feasible"
    onto_frequency = side("bus", later, frequency_headway_min=6)
    assert (
        assess(
            side("rail", base), side("bus", later, cancelled=True, frequency_headway_min=6), 0
        ).label
        == "not_feasible"
    )
    assert assess(side("rail", base), onto_frequency, 0).label is None


def test_arriving_on_a_frequency_service_is_uncertain() -> None:
    base = at(12, 0)
    arriving = side("bus", base, live=False, frequency_headway_min=8)
    res = assess(arriving, side("rail", base + timedelta(minutes=10)), walk_s=60)
    assert res.label == "uncertain"
    late = assess(arriving, side("rail", base - timedelta(minutes=1)), walk_s=60)
    assert late.label == "not_feasible"
    # Unknown mode: no allowance known, so no claim.
    assert (
        assess(side("ferry", base, live=False), side("rail", base + timedelta(minutes=30)), 0).label
        == "uncertain"
    )


def test_worst_label() -> None:
    assert worst([]) is None and worst([None]) is None
    assert worst(["comfortable", "uncertain", "tight"]) == "uncertain"
    assert worst(["tight", "not_feasible", None]) == "not_feasible"


# ---------------------------------------------------------------------------
# Direction of a leg without a headsign (Renfe publishes none)


def test_renfe_leg_gets_its_terminus_as_direction(setup: Callable[..., TestClient]) -> None:
    static = FakeStatic(
        termini={("cercanias", C4A_TRIP): "Alcobendas - San Sebastián de los Reyes"}
    )
    body = plan(setup(FakeOtp(load("parla_atocha")), static))
    legs = [lg for j in body["journeys"] for lg in j["legs"] if lg.get("trip_id")]
    c4a = next(lg for lg in legs if lg["trip_id"] == f"cercanias:{C4A_TRIP}")
    assert c4a["headsign"] == "Alcobendas - San Sebastián de los Reyes"
    assert c4a["headsign"] != c4a["to"]  # not the passenger's own destination
    # Legs with a headsign (the recorded buses) keep it and are not looked up.
    assert static.termini_asked and all(feed == "cercanias" for feed, _ in static.termini_asked)
    assert any(lg["headsign"] and lg["mode"] == "bus" for lg in legs)


def test_unknown_terminus_leaves_no_direction(setup: Callable[..., TestClient]) -> None:
    body = plan(setup(FakeOtp(load("parla_atocha")), FakeStatic()))
    c4a = next(
        lg
        for j in body["journeys"]
        for lg in j["legs"]
        if lg.get("trip_id") == f"cercanias:{C4A_TRIP}"
    )
    assert c4a["headsign"] is None  # the app then shows no wrong direction
