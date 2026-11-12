"""Address and place search (`GET /places/search`), on CartoCiudad answers recorded on
2026-11-12 (tests/fixtures/places/). No network: CartoCiudad is replaced by a mock transport."""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.places import (
    CENTRE,
    Geocoder,
    PlaceResult,
    get_geocoder,
    nice_case,
    rank,
    street_point,
    to_place,
)
from app.realtime.cache import MemoryKV, get_kv

FIXTURES = Path(__file__).parent / "fixtures" / "places"


def load(name: str) -> Any:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


# (query, area filter) -> recorded answer
ANSWERS = {
    ("calle mayor 5", "provincia_filter"): "cc_calle_mayor_5",
    ("calle mayor 5", "municipio_filter"): "cc_calle_mayor_5_city",
    ("hospital 12 de octubre", "provincia_filter"): "cc_hospital_12_octubre",
    ("calle real parla", "provincia_filter"): "cc_calle_real_parla",
}


class Recorder:
    def __init__(self, fail: bool = False) -> None:
        self.calls: list[httpx.Request] = []
        self.fail = fail

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if self.fail:
            return httpx.Response(502)
        params = request.url.params
        if request.url.path.endswith("/find"):
            if params["id"] == "281060000261":
                return httpx.Response(200, json=load("cc_find_calle_real_parla"))
            return httpx.Response(200, json={"geom": None})
        area = "provincia_filter" if "provincia_filter" in params else "municipio_filter"
        name = ANSWERS.get((params["q"], area))
        return httpx.Response(200, json=load(name) if name else [])


def geocoder(rec: Recorder) -> Geocoder:
    return Geocoder(httpx.AsyncClient(transport=httpx.MockTransport(rec)), "https://cc.test", 3.0)


@pytest.fixture
def rec() -> Recorder:
    return Recorder()


@pytest.fixture
def client(rec: Recorder) -> Iterator[TestClient]:
    kv = MemoryKV()
    app.dependency_overrides[get_geocoder] = lambda: geocoder(rec)
    app.dependency_overrides[get_kv] = lambda: kv
    yield TestClient(app)
    app.dependency_overrides.clear()


def search(client: TestClient, q: str, **params: Any) -> list[dict[str, Any]]:
    resp = client.get("/places/search", params={"q": q, **params})
    assert resp.status_code == 200, resp.text
    return list(resp.json())


def test_madrid_address_first_among_towns_with_the_same_street(client: TestClient) -> None:
    places = search(client, "calle mayor 5")
    first = places[0]
    assert (first["name"], first["detail"], first["kind"]) == (
        "Calle Mayor 5",
        "28012 Madrid",
        "address",
    )
    assert first["lat"] == pytest.approx(40.41636, abs=1e-4)
    # The same address in other towns follows, nearest the centre first.
    same = [p for p in places if p["name"] == "Calle Mayor 5"]
    assert len(same) > 3
    assert all(p["kind"] == "address" and p["detail"] for p in same)


def test_place_by_name_and_no_stops(client: TestClient) -> None:
    places = search(client, "hospital 12 de octubre")
    assert places[0]["name"] == "Hospital Universitario 12 de Octubre"
    assert places[0]["detail"] == "Madrid"
    assert places[0]["kind"] == "place"
    # CartoCiudad also lists the Metro station; the stop search has it with its lines.
    assert not any(p["name"].lower().startswith("estación") for p in places)


def test_streets_get_a_point_and_businesses_come_last(client: TestClient, rec: Recorder) -> None:
    places = search(client, "calle real parla")
    first = places[0]
    assert (first["name"], first["detail"], first["kind"]) == ("Calle Real", "Parla", "street")
    assert first["lat"] == pytest.approx(40.2448, abs=1e-3)
    assert first["lon"] == pytest.approx(-3.7679, abs=1e-3)
    # Streets the mock has no shape for are left out: no point to plan from.
    assert all(p["lat"] for p in places)
    shops = [p for p in places if p["business"]]
    assert shops and places[-len(shops) :] == shops
    assert shops[0]["name"] == "Estación de servicio BALLENOIL"
    assert shops[0]["detail"] == "Calle Real, 125 · Parla"
    assert sum(r.url.path.endswith("/find") for r in rec.calls) <= 4


def test_answers_are_cached(client: TestClient, rec: Recorder) -> None:
    search(client, "hospital 12 de octubre")
    n = len(rec.calls)
    search(client, "  Hospital 12 de  OCTUBRE ")
    assert len(rec.calls) == n


def test_short_query_is_refused(client: TestClient) -> None:
    assert client.get("/places/search", params={"q": "ab"}).status_code == 422
    assert client.get("/places/search", params={"q": "  ab   "}).status_code == 422


def test_unavailable_geocoder_answers_503_in_spanish() -> None:
    kv = MemoryKV()
    app.dependency_overrides[get_geocoder] = lambda: geocoder(Recorder(fail=True))
    app.dependency_overrides[get_kv] = lambda: kv
    try:
        resp = TestClient(app).get(
            "/places/search", params={"q": "calle mayor 5"}, headers={"Accept-Language": "es"}
        )
    finally:
        app.dependency_overrides.clear()
    assert resp.status_code == 503
    assert "direcciones" in resp.json()["detail"]


def test_nice_case() -> None:
    assert nice_case("CALLE MAYOR DE LA VILLA 5") == "Calle Mayor de la Villa 5"
    assert (
        nice_case("HOSPITAL UNIVERSITARIO 12 DE OCTUBRE") == "Hospital Universitario 12 de Octubre"
    )
    assert nice_case("Estadio Santiago Bernabéu") == "Estadio Santiago Bernabéu"
    assert nice_case("COLEGIO CARLOS III") == "Colegio Carlos III"


def test_to_place_leaves_out_kinds_and_far_points() -> None:
    base = {"id": "1", "muni": "Madrid", "lat": 40.4, "lng": -3.7, "province": "Madrid"}
    assert to_place({**base, "type": "expendeduria", "address": "ESTANCO 5, Madrid"}) is None
    assert to_place({**base, "type": "toponimo", "address": "Parada de autobús X, Madrid"}) is None
    far = {**base, "type": "portal", "address": "CALLE MAYOR 5, Madrid", "lat": 42.3}
    assert to_place(far) is None
    ok = to_place(
        {**base, "type": "portal", "address": "CALLE MAYOR 5, Madrid", "postalCode": "28012"}
    )
    assert ok is not None and (ok.name, ok.detail) == ("Calle Mayor 5", "28012 Madrid")


def test_rank_orders_equal_names_by_distance() -> None:
    def p(name: str, lat: float, detail: str = "X", business: bool = False) -> PlaceResult:
        return PlaceResult(
            id=f"{name}{lat}",
            name=name,
            detail=detail,
            kind="address",
            lat=lat,
            lon=-3.7,
            business=business,
        )

    far, near, other, shop = p("A", 40.9), p("A", 40.42), p("B", 40.0), p("C", 40.41, business=True)
    assert rank([shop, far, other, near], CENTRE) == [near, far, other, shop]


def test_street_point_is_on_the_street() -> None:
    point = street_point("MULTILINESTRING((-3.70 40.40,-3.71 40.41),(-3.71 40.41,-3.72 40.42))")
    assert point == (40.41, -3.71)
    assert street_point(None) is None
    assert street_point("LINESTRING(0 0, 0 0)") is None
