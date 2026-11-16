"""Lines a feed lists without trips: their stops from CRTM's network map, and the notice."""

from datetime import date

import httpx
import pytest

from app.i18n import set_lang
from app.ingest import untimed
from app.ingest.untimed import stops_by_route
from app.untimed import untimed_message

TODAY = date(2026, 11, 16)


def row(route: str, station: str, start: str | None = "20250804", end: str | None = None) -> dict:
    return {"IDFLINEA": route, "IDFESTACION": station, "FECHAINICIO": start, "FECHAFIN": end}


def test_stops_by_route_maps_stations_to_gtfs_stops() -> None:
    rows = [
        row("8__721___", "8_11350"),
        row("8__721___", "8_11350"),  # same stop on the other itinerary
        row("8__721___", "8_12108"),
        row("9__SE__161_", "8_20001"),
    ]
    assert stops_by_route(rows, TODAY) == {
        "8__721___": {"par_8_11350", "par_8_12108"},
        "9__SE__161_": {"par_8_20001"},
    }


def test_stops_by_route_keeps_only_rows_in_force_today() -> None:
    rows = [
        row("8__721___", "8_1", end="20261115"),  # ended yesterday
        row("8__721___", "8_2", end="20261116"),  # ends today: still in force
        row("8__721___", "8_3", start="20261117"),  # starts tomorrow
        row("8__721___", "8_4", start=None, end=None),
        {"IDFLINEA": "8__721___", "IDFESTACION": None},
    ]
    assert stops_by_route(rows, TODAY) == {"8__721___": {"par_8_2", "par_8_4"}}


def test_fetch_layer_reads_every_page(monkeypatch: pytest.MonkeyPatch) -> None:
    offsets: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        form = dict(x.split("=", 1) for x in request.content.decode().split("&"))
        offsets.append(form["resultOffset"])
        if form["resultOffset"] == "0":
            feats = [{"attributes": row("8__721___", f"8_{i}")} for i in range(2)]
            return httpx.Response(200, json={"features": feats, "exceededTransferLimit": True})
        return httpx.Response(200, json={"features": [{"attributes": row("8__721___", "8_9")}]})

    real = httpx.Client
    monkeypatch.setattr(
        untimed.httpx,
        "Client",
        lambda **kw: real(transport=httpx.MockTransport(handler), **kw),
    )
    rows = untimed.fetch_layer("https://example.test/layer/3", ["8__721___"])
    assert [r["IDFESTACION"] for r in rows] == ["8_0", "8_1", "8_9"]
    assert offsets == ["0", "2"]


def test_fetch_layer_raises_on_arcgis_error(monkeypatch: pytest.MonkeyPatch) -> None:
    real = httpx.Client
    monkeypatch.setattr(
        untimed.httpx,
        "Client",
        lambda **kw: real(
            transport=httpx.MockTransport(
                lambda r: httpx.Response(200, json={"error": {"code": 400}})
            ),
            **kw,
        ),
    )
    with pytest.raises(RuntimeError):
        untimed.fetch_layer("https://example.test/layer/3", ["8__721___"])


def test_untimed_message_in_both_languages() -> None:
    assert untimed_message(["721"]) == (
        "Line 721 also stops here, but CRTM publishes no timetable for it, so MadridGo "
        "cannot show its times or use it in connections."
    )
    assert untimed_message(["721", "N702"], "Plaza de Castilla").startswith(
        "Lines 721, N702 also stop at Plaza de Castilla, but"
    )
    set_lang("es")
    try:
        assert untimed_message(["721", "722"]).startswith(
            "Las líneas 721, 722 también paran aquí, pero el CRTM no publica su horario"
        )
        assert untimed_message(["SE"], "Valdemoro").startswith(
            "La línea SE también para en Valdemoro"
        )
    finally:
        set_lang("en")
