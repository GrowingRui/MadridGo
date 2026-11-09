"""Reading GTFS zip files: locating tables, and parsing times, dates and names."""

import csv
import io
import unicodedata
import zipfile
from collections.abc import Iterator
from datetime import date
from pathlib import Path


class GtfsZip:
    """A GTFS zip. Some CRTM zips keep their files in a subfolder; this finds them."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._zip = zipfile.ZipFile(path)
        names = self._zip.namelist()
        stops = [n for n in names if n == "stops.txt" or n.endswith("/stops.txt")]
        if not stops:
            raise ValueError(f"{path.name}: no stops.txt, not a GTFS feed")
        self.prefix = stops[0].removesuffix("stops.txt")
        self._names = {n.removeprefix(self.prefix) for n in names if n.startswith(self.prefix)}

    def __enter__(self) -> "GtfsZip":
        return self

    def __exit__(self, *exc: object) -> None:
        self._zip.close()

    def has(self, table: str) -> bool:
        return f"{table}.txt" in self._names

    def rows(self, table: str) -> Iterator[dict[str, str]]:
        """Yield rows as dicts with stripped values. Missing table yields nothing."""
        if not self.has(table):
            return
        with self._zip.open(f"{self.prefix}{table}.txt") as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
            for row in reader:
                yield {k.strip(): (v or "").strip() for k, v in row.items() if k is not None}


def parse_time(value: str) -> int | None:
    """GTFS time 'H:MM:SS' (hours may exceed 23) to seconds after service-day midnight."""
    if not value:
        return None
    h, m, s = value.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def parse_date(value: str) -> date:
    return date(int(value[0:4]), int(value[4:6]), int(value[6:8]))


def opt_int(value: str) -> int | None:
    return int(value) if value else None


def fold(text: str) -> str:
    """Lower-case and strip accents, for accent-insensitive search ('Chamartín' -> 'chamartin')."""
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return " ".join(stripped.split())


def color(value: str) -> str | None:
    """Normalise a GTFS colour to 'RRGGBB' upper case, or None if missing/invalid."""
    v = value.strip().lstrip("#").upper()
    return v if len(v) == 6 and all(c in "0123456789ABCDEF" for c in v) else None
