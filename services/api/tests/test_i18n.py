"""Spanish and English messages (app/i18n.py)."""

import re
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.i18n import MESSAGES, LanguageMiddleware, current_lang, parse_accept_language, set_lang, tr
from app.transfers import TransferSide, assess


@pytest.fixture(autouse=True)
def _english_after():
    yield
    set_lang("en")


@pytest.mark.parametrize(
    ("header", "lang"),
    [
        (None, "en"),
        ("", "en"),
        ("es", "es"),
        ("es-ES,es;q=0.9,en;q=0.8", "es"),
        ("en-GB,en;q=0.9,es;q=0.8", "en"),
        ("fr-FR,es;q=0.5,en;q=0.7", "en"),
        ("fr-FR,es;q=0.5", "es"),
        ("de", "en"),
        ("es;q=0,en", "en"),
        ("ES-es", "es"),
    ],
)
def test_parse_accept_language(header, lang):
    assert parse_accept_language(header) == lang


def test_every_message_has_both_languages_with_the_same_placeholders():
    for key, entry in MESSAGES.items():
        assert set(entry) == {"en", "es"}, key
        names = [set(re.findall(r"{(\w+)}", entry[lang])) for lang in ("en", "es")]
        assert names[0] == names[1], key


def test_tr_uses_the_current_language_and_formats_dates():
    end = date(2025, 5, 30)
    assert tr("notice.expiring", operator="Metro", days=3) == "The Metro timetable ends in 3 days."
    assert "2025-05-30" in tr("notice.expired_board", operator="Metro", end=end)
    set_lang("es")
    assert tr("notice.expiring", operator="Metro", days=3) == (
        "El horario de Metro termina dentro de 3 días."
    )
    assert "caducó el 30/05/2025" in tr("notice.expired_board", operator="Metro", end=end)


def test_unknown_language_falls_back_to_english():
    set_lang("fr")
    assert current_lang() == "en"


def test_pure_functions_answer_in_the_request_language():
    t = datetime(2026, 11, 10, 8, 0, tzinfo=UTC)
    arriving = TransferSide(mode="rail", time=t, live=True)
    departing = TransferSide(mode="rail", time=t + timedelta(minutes=10), live=False)
    assert "based on live times" in assess(arriving, departing, 60).message
    set_lang("es")
    assert assess(arriving, departing, 60).message == (
        "9 min de margen después de caminar, según los horarios en tiempo real."
    )


def _app() -> FastAPI:
    app = FastAPI()

    @app.get("/async")
    async def async_endpoint() -> dict[str, str]:
        return {"message": tr("pos.cancelled")}

    @app.get("/sync")
    def sync_endpoint() -> dict[str, str]:  # runs in the thread pool
        return {"message": tr("pos.cancelled")}

    app.add_middleware(LanguageMiddleware)
    return app


@pytest.mark.parametrize("path", ["/async", "/sync"])
def test_middleware_sets_the_language_per_request(path):
    client = TestClient(_app())
    es = client.get(path, headers={"Accept-Language": "es"})
    assert es.json() == {"message": "Este tren está cancelado."}
    assert es.headers["content-language"] == "es"
    assert "Accept-Language" in es.headers["vary"]
    en = client.get(path)
    assert en.json() == {"message": "This train is cancelled."}
    assert en.headers["content-language"] == "en"
    # The language does not leak out of the request.
    assert current_lang() == "en"
