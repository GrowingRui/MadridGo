"""Cut a GTFS feed down to the routes of one network (e.g. Renfe's national Cercanías feed
to Madrid). The result has its .txt files at the zip root and values without the padding
spaces Renfe adds."""

import csv
import io
import re
import zipfile
from collections.abc import Callable
from itertools import chain
from pathlib import Path

from app.ingest.gtfs import GtfsZip

# Tables filtered by a set of kept IDs: table -> (column, kind of ID).
_BY = {
    "routes": ("route_id", "route"),
    "trips": ("trip_id", "trip"),
    "stop_times": ("trip_id", "trip"),
    "frequencies": ("trip_id", "trip"),
    "calendar": ("service_id", "service"),
    "calendar_dates": ("service_id", "service"),
    "shapes": ("shape_id", "shape"),
}

Rule = Callable[[dict[str, str]], bool]

_SPACES = re.compile(r"\s+")
_LOOSE_DASH = re.compile(r" -(?=\S)|(?<=\S)- ")


def tidy_name(name: str) -> str:
    """Renfe's route_long_name pads the first terminus to 40 characters ("Colmenar Viejo
    <26 spaces>-Parla"): one space between words and " - " between the termini."""
    return _LOOSE_DASH.sub(" - ", _SPACES.sub(" ", name).strip())


# Written in this order: each table's kept IDs are known once the tables before it are read.
_ORDER = ("routes", "trips", "stop_times", "frequencies", "calendar", "calendar_dates", "shapes")


def subset(
    src: Path,
    dest: Path,
    route_prefix: str,
    positions: tuple[tuple[str, float, float], ...] = (),
) -> dict[str, int]:
    """Write to dest the routes whose route_id starts with route_prefix and everything they
    use, with the stops in `positions` moved to the given (lat, lon). Returns the number of
    rows written per table."""
    moved = {stop_id: (lat, lon) for stop_id, lat, lon in positions}
    keep: dict[str, set[str]] = {"route": set(), "trip": set(), "service": set(), "shape": set()}
    stops: set[str] = set()
    counts: dict[str, int] = {}
    with GtfsZip(src) as feed, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as out:

        def write(table: str, wanted: Rule) -> None:
            if not feed.has(table):
                return
            rows = feed.rows(table)
            first = next(rows, None)
            if first is None:
                return
            n = 0
            with out.open(f"{table}.txt", "w") as raw:
                text = io.TextIOWrapper(raw, encoding="utf-8", newline="")
                w = csv.DictWriter(text, fieldnames=list(first), lineterminator="\n")
                w.writeheader()
                for row in chain([first], rows):
                    if wanted(row):
                        w.writerow(row)
                        n += 1
                text.flush()
                text.detach()
            counts[table] = n

        def routes(row: dict[str, str]) -> bool:
            if not row["route_id"].startswith(route_prefix):
                return False
            for column in ("route_short_name", "route_long_name"):
                if row.get(column):
                    row[column] = tidy_name(row[column])
            keep["route"].add(row["route_id"])
            return True

        def trips(row: dict[str, str]) -> bool:
            if row["route_id"] not in keep["route"]:
                return False
            keep["trip"].add(row["trip_id"])
            keep["service"].add(row["service_id"])
            if row.get("shape_id"):
                keep["shape"].add(row["shape_id"])
            return True

        def stop_times(row: dict[str, str]) -> bool:
            if row["trip_id"] not in keep["trip"]:
                return False
            stops.add(row["stop_id"])
            return True

        def by_id(column: str, kind: str) -> Rule:
            return lambda row: row.get(column, "") in keep[kind]

        rules: dict[str, Rule] = {"routes": routes, "trips": trips, "stop_times": stop_times}
        for table in _ORDER:
            write(table, rules.get(table) or by_id(*_BY[table]))

        # Stops: the ones served, plus their parent stations.
        parents = {
            r["parent_station"]
            for r in feed.rows("stops")
            if r["stop_id"] in stops and r.get("parent_station")
        }
        stops |= parents

        def kept_stop(row: dict[str, str]) -> bool:
            if row["stop_id"] not in stops:
                return False
            if row["stop_id"] in moved:
                lat, lon = moved[row["stop_id"]]
                row["stop_lat"], row["stop_lon"] = f"{lat:.7f}", f"{lon:.7f}"
            return True

        write("stops", kept_stop)
        write("transfers", lambda r: r["from_stop_id"] in stops and r["to_stop_id"] in stops)
        # Routes may omit agency_id (Renfe does: one agency), so keep every agency.
        write("agency", lambda r: True)
        if feed.has("feed_info"):
            write("feed_info", lambda r: True)
    return counts
