"""Pure helpers for scheduled times: service days, GTFS seconds and display names.

Nothing here touches the database, so it is unit-tested directly.
"""

import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

MADRID = ZoneInfo("Europe/Madrid")


def service_day_start(day: date) -> datetime:
    """GTFS times count from 'noon minus 12 h' of the service day (correct across DST changes)."""
    return datetime.combine(day, time(12), MADRID) - timedelta(hours=12)


def at_service_time(day: date, seconds: int) -> datetime:
    """The wall-clock instant of a GTFS time on a service day, in Madrid time."""
    return (service_day_start(day) + timedelta(seconds=seconds)).astimezone(MADRID)


def seconds_into(day: date, instant: datetime) -> int:
    """Seconds since the start of service day `day` (negative if before it)."""
    return int((instant - service_day_start(day)).total_seconds())


# route_type (GTFS basic + common extended values) -> MadridGo mode
_ROUTE_TYPE_MODE = {0: "light_rail", 1: "metro", 2: "rail", 3: "bus", 700: "bus", 900: "light_rail"}
MODE_ORDER = {"rail": 0, "metro": 1, "light_rail": 2, "bus": 3}


def mode_for(route_type: int) -> str:
    if route_type in _ROUTE_TYPE_MODE:
        return _ROUTE_TYPE_MODE[route_type]
    if 100 <= route_type < 200:
        return "rail"
    if 400 <= route_type < 500:
        return "metro"
    return "bus"


_ROMAN = re.compile(r"(X{0,3})(IX|IV|V?I{0,3})")
_SMALL_WORDS = {"de", "del", "la", "las", "los", "el", "y", "a", "en"}


def display_name(name: str) -> str:
    """Make ALL-CAPS feed names readable ('AV.LEGUARIO-LUIS CHAMIZO' -> 'Av. Leguario - Luis
    Chamizo'). Names that already use mixed case are only tidied."""
    text = " ".join(name.split())
    if text.upper() == text and any(c.isalpha() for c in text):
        words = text.lower().split(" ")
        text = " ".join(
            w if (i > 0 and w in _SMALL_WORDS) else w[:1].upper() + w[1:]
            for i, w in enumerate(words)
        )
        # Capitalise after '.', '-', '(', '/', 'º' and 'ª' inside words:
        # 'av.leguario' -> 'Av.Leguario', 'gªmárquez' -> 'Gª Márquez' (spaced below)
        text = re.sub(r"([.\-(/ºª])(\w)", lambda m: m.group(1) + m.group(2).upper(), text)
        # Roman numerals stay upper case: 'Juan Pablo Ii' -> 'Juan Pablo II'
        text = re.sub(
            r"\b([IVXivx]{1,4})\b",
            lambda m: m.group(1).upper() if _ROMAN.fullmatch(m.group(1).upper()) else m.group(1),
            text,
        )
    text = re.sub(r"([ºª])(?=\w)", r"\1 ", text)  # 'Pºandes' -> 'Pº Andes'
    text = re.sub(r"\.(?=\w)", ". ", text)  # 'Av.Leguario' -> 'Av. Leguario'
    text = re.sub(r"\s*-\s*", " - ", text)
    return text


_NUM = re.compile(r"(\d+)")


def line_sort_key(short_name: str | None) -> tuple[object, ...]:
    """Natural sort: C2 < C10, 3 < 27 < N1."""
    parts = _NUM.split(short_name or "")
    return tuple(int(p) if p.isdigit() else p for p in parts)
