"""User-facing messages in Spanish and English.

The app sends `Accept-Language: es` or `en`; the middleware in main.py puts the language in a
context variable for the request, and `tr()` returns the message in it. Anything without a
request (CLI, worker, tests) gets English, the default.

Station, line and operator names are never translated; operator alert texts come as the
operator publishes them.
"""

from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from datetime import date
from typing import Any

LANGS = ("es", "en")
DEFAULT_LANG = "en"

_lang: ContextVar[str] = ContextVar("lang", default=DEFAULT_LANG)


def current_lang() -> str:
    return _lang.get()


def set_lang(lang: str) -> None:
    _lang.set(lang if lang in LANGS else DEFAULT_LANG)


def parse_accept_language(header: str | None) -> str:
    """The first supported language in an Accept-Language header, by quality; else English."""
    if not header:
        return DEFAULT_LANG
    best: tuple[float, int, str] | None = None
    for pos, part in enumerate(header.split(",")):
        tag, _, params = part.strip().partition(";")
        code = tag.strip().lower().split("-", 1)[0]
        if code not in LANGS:
            continue
        q = 1.0
        for p in params.split(";"):
            k, _, v = p.strip().partition("=")
            if k == "q":
                try:
                    q = float(v)
                except ValueError:
                    q = 0.0
        if q <= 0:
            continue
        # Higher quality first; on a tie, the earlier entry.
        if best is None or (q, -pos) > (best[0], best[1]):
            best = (q, -pos, code)
    return best[2] if best else DEFAULT_LANG


class LanguageMiddleware:
    """Sets the request's language from Accept-Language (pure ASGI, so the context variable
    reaches the endpoint and its thread pool) and labels the response with it."""

    def __init__(self, app: Callable[..., Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        header = next(
            (v.decode("latin-1") for k, v in scope.get("headers", []) if k == b"accept-language"),
            None,
        )
        lang = parse_accept_language(header)
        token = _lang.set(lang)

        async def send_labelled(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                headers = [
                    *message.get("headers", []),
                    (b"content-language", lang.encode()),
                    (b"vary", b"Accept-Language"),
                ]
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_labelled)
        finally:
            _lang.reset(token)


def _fmt(value: object, lang: str) -> str:
    if isinstance(value, date):
        return value.strftime("%d/%m/%Y") if lang == "es" else value.isoformat()
    return str(value)


def tr(key: str, **params: object) -> str:
    """The message `key` in the request's language, with `{name}` placeholders filled."""
    lang = current_lang()
    entry = MESSAGES[key]
    text = entry.get(lang) or entry[DEFAULT_LANG]
    return text.format(**{k: _fmt(v, lang) for k, v in params.items()})


MESSAGES: dict[str, dict[str, str]] = {
    # --- Journey search (OTP routing errors) --------------------------------------------
    "routing.NO_TRANSIT_CONNECTION": {
        "en": "No public transport connection found.",
        "es": "No hay ninguna conexión en transporte público.",
    },
    "routing.NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW": {
        "en": "No connection in this time window. Try later connections.",
        "es": "No hay conexiones en este intervalo. Prueba con conexiones más tarde.",
    },
    "routing.OUTSIDE_SERVICE_PERIOD": {
        "en": "There is no timetable for this date yet.",
        "es": "Todavía no hay horarios para esta fecha.",
    },
    "routing.OUTSIDE_BOUNDS": {
        "en": "Start or destination is outside the area MadridGo covers.",
        "es": "El origen o el destino está fuera de la zona que cubre MadridGo.",
    },
    "routing.LOCATION_NOT_FOUND": {
        "en": "Start or destination could not be found on the map.",
        "es": "No se ha encontrado el origen o el destino en el mapa.",
    },
    "routing.NO_STOPS_IN_RANGE": {
        "en": "There is no stop within walking distance of the start or destination.",
        "es": "No hay ninguna parada a distancia a pie del origen o del destino.",
    },
    "routing.WALKING_BETTER_THAN_TRANSIT": {
        "en": "It is quicker to walk.",
        "es": "Es más rápido ir andando.",
    },
    "routing.default": {
        "en": "No connection found.",
        "es": "No se ha encontrado ninguna conexión.",
    },
    # --- Timetable validity --------------------------------------------------------------
    "notice.expired_journeys": {
        "en": "The official {operator} timetable expired on {end}. "
        "{operator} is not used in these journeys.",
        "es": "El horario oficial de {operator} caducó el {end}. "
        "{operator} no se usa en estos trayectos.",
    },
    "notice.expired_board": {
        "en": "The official {operator} timetable expired on {end}. "
        "No scheduled times are available for it.",
        "es": "El horario oficial de {operator} caducó el {end}. "
        "No hay horarios programados disponibles.",
    },
    "notice.expiring": {
        "en": "The {operator} timetable ends in {days} days.",
        "es": "El horario de {operator} termina dentro de {days} días.",
    },
    # --- Journey problems ----------------------------------------------------------------
    "issue.cancelled": {
        "en": "{line} {time} from {stop} is cancelled.",
        "es": "El {line} de las {time} desde {stop} está cancelado.",
    },
    "issue.left": {
        "en": "{line} {time} has already left {stop}.",
        "es": "El {line} de las {time} ya ha salido de {stop}.",
    },
    "issue.change": {
        "en": "Change at {stop}: {message}",
        "es": "Transbordo en {stop}: {message}",
    },
    # --- Changes (RELIABILITY_STRATEGY.md §5) ---------------------------------------------
    "transfer.arriving_cancelled": {
        "en": "The arriving trip is cancelled.",
        "es": "El servicio de llegada está cancelado.",
    },
    "transfer.departing_cancelled": {
        "en": "The connecting trip is cancelled.",
        "es": "El servicio de enlace está cancelado.",
    },
    "transfer.frequency": {
        "en": "Frequent service: wait up to {n} min for the next one.",
        "es": "Servicio frecuente: espera como máximo {n} min al siguiente.",
    },
    "transfer.leaves_before": {
        "en": "The connection leaves before you arrive.",
        "es": "El enlace sale antes de que llegues.",
    },
    "transfer.uncertain": {
        "en": "Arrival time not known precisely; this change may be tight.",
        "es": "La hora de llegada no se conoce con precisión; el transbordo puede ser justo.",
    },
    "transfer.not_enough": {
        "en": "Not enough time to change.",
        "es": "No hay tiempo suficiente para el transbordo.",
    },
    "transfer.not_enough_late": {
        "en": "Not enough time to change: the arriving vehicle is running late.",
        "es": "No hay tiempo suficiente para el transbordo: el vehículo de llegada va con retraso.",
    },
    "transfer.spare_live": {
        "en": "{n} min to spare after walking, based on live times.",
        "es": "{n} min de margen después de caminar, según los horarios en tiempo real.",
    },
    "transfer.spare_scheduled": {
        "en": "{n} min to spare after walking, based on the timetable.",
        "es": "{n} min de margen después de caminar, según el horario.",
    },
    # --- Live data status per operator ----------------------------------------------------
    "rt.emt_window": {
        "en": "Live EMT times are shown for buses leaving in the next 45 minutes.",
        "es": "Los horarios de EMT en tiempo real se muestran para los autobuses "
        "que salen en los próximos 45 minutos.",
    },
    "rt.live": {
        "en": "Live data from {operator}.",
        "es": "Datos en tiempo real de {operator}.",
    },
    "rt.delayed_update": {
        "en": "Live data from {operator}, last updated {age} ago.",
        "es": "Datos en tiempo real de {operator}, actualizados hace {age}.",
    },
    "rt.stale": {
        "en": "Live data is outdated (last update {age} ago). Showing the timetable.",
        "es": "Los datos en tiempo real están desactualizados (última actualización hace {age}). "
        "Se muestra el horario.",
    },
    "rt.unavailable": {
        "en": "Live data is unavailable right now. Showing the timetable.",
        "es": "Los datos en tiempo real no están disponibles ahora. Se muestra el horario.",
    },
    "rt.not_configured": {
        "en": "Live data is not set up on this server. Showing the timetable.",
        "es": "Los datos en tiempo real no están configurados en este servidor. "
        "Se muestra el horario.",
    },
    "rt.none.metro": {
        "en": "Metro de Madrid does not publish real-time data. Times come from the timetable.",
        "es": "Metro de Madrid no publica datos en tiempo real. Las horas son las del horario.",
    },
    "rt.none.ml": {
        "en": "Metro Ligero does not publish real-time data. Times come from the timetable.",
        "es": "Metro Ligero no publica datos en tiempo real. Las horas son las del horario.",
    },
    "rt.none.bus": {
        "en": "Real-time is not available for this line in MadridGo. "
        "Times come from the timetable.",
        "es": "El tiempo real no está disponible para esta línea en MadridGo. "
        "Las horas son las del horario.",
    },
    "rt.none.default": {
        "en": "No real-time data. Times come from the timetable.",
        "es": "Sin datos en tiempo real. Las horas son las del horario.",
    },
    # --- Train positions -----------------------------------------------------------------
    "pos.none.metro": {
        "en": "Metro de Madrid does not publish train positions.",
        "es": "Metro de Madrid no publica la posición de los trenes.",
    },
    "pos.none.ml": {
        "en": "Metro Ligero does not publish vehicle positions.",
        "es": "Metro Ligero no publica la posición de los vehículos.",
    },
    "pos.none.bus": {
        "en": "Bus positions are not available in MadridGo yet.",
        "es": "La posición de los autobuses aún no está disponible en MadridGo.",
    },
    "pos.none.default": {
        "en": "No vehicle positions for this line.",
        "es": "No hay posiciones de vehículos para esta línea.",
    },
    "pos.not_running": {
        "en": "This train is not running now.",
        "es": "Este tren no está circulando ahora.",
    },
    "pos.not_started": {
        "en": "This train starts at {stop} at {time}.",
        "es": "Este tren sale de {stop} a las {time}.",
    },
    "pos.cancelled": {
        "en": "This train is cancelled.",
        "es": "Este tren está cancelado.",
    },
    "pos.estimated_at": {
        "en": "Estimated at {stop}. {why}",
        "es": "Posición estimada: en {stop}. {why}",
    },
    "pos.estimated_between": {
        "en": "Estimated between {a} and {b}. {why}",
        "es": "Posición estimada: entre {a} y {b}. {why}",
    },
    "pos.why_no_live_data": {
        "en": "Live data is unavailable or outdated: timetable estimate.",
        "es": "Los datos en tiempo real no están disponibles o están desactualizados: "
        "estimación según el horario.",
    },
    "pos.why_delay": {
        "en": "From the timetable and the live delay.",
        "es": "Según el horario y el retraso en tiempo real.",
    },
    "pos.why_no_position": {
        "en": "No live position for this train: timetable estimate.",
        "es": "No hay posición en tiempo real de este tren: estimación según el horario.",
    },
    "pos.at": {"en": "At {stop}", "es": "En {stop}"},
    "pos.between": {"en": "Between {a} and {b}", "es": "Entre {a} y {b}"},
}
