"""Repairs for lines a feed leaves out or cuts short (configured per source in sources.py).

- restore_route: a line with no trips at all gets its trips back from an older file of the
  same feed (Metro Line 3: CRTM's May 2025 file dropped it, the March 2025 file has it).
- extend_route: a line whose newer end station is missing gets one more stop at that end,
  with a run time from CRTM's network data (Line 3 to El Casar, open since 2025-04-21).

Each repair only acts while the feed still has the gap, so a corrected CRTM file is used as
published. The shape is extended with a straight segment to the new stop.
"""

import csv
import io
import zipfile
from dataclasses import dataclass
from math import cos, hypot, radians
from pathlib import Path

from app.ingest.gtfs import GtfsZip, parse_time


@dataclass(frozen=True)
class RouteRestore:
    route_id: str
    url: str  # an older file of the same feed that still has the line
    sha256: str  # of that file, so a different file is never used silently


@dataclass(frozen=True)
class RouteExtension:
    route_id: str
    at_stop: str  # current end of the line
    stop_id: str  # new end stop
    stop_code: str
    name: str
    lat: float
    lon: float
    run_s: int  # running time between at_stop and the new stop
    parent_station: str = ""  # station the new stop belongs to (e.g. an interchange)


class Tables:
    """A whole (small, flattened) feed in memory: table -> (columns, rows)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.data: dict[str, tuple[list[str], list[dict[str, str]]]] = {}
        self.other: dict[str, bytes] = {}
        with zipfile.ZipFile(path) as z:
            for name in z.namelist():
                if not name.endswith(".txt"):
                    self.other[name] = z.read(name)
                    continue
                text = io.TextIOWrapper(z.open(name), encoding="utf-8-sig", newline="")
                reader = csv.DictReader(text)
                rows = [{k: (v or "") for k, v in r.items() if k is not None} for r in reader]
                self.data[name.removesuffix(".txt")] = (list(reader.fieldnames or []), rows)

    def rows(self, table: str) -> list[dict[str, str]]:
        return self.data.get(table, ([], []))[1]

    def add_column(self, table: str, column: str) -> None:
        cols = self.data[table][0]
        if column not in cols:
            cols.append(column)

    def save(self) -> None:
        tmp = self.path.with_suffix(".patch.zip")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for table, (cols, rows) in self.data.items():
                out = io.StringIO()
                w = csv.DictWriter(out, fieldnames=cols, extrasaction="ignore", lineterminator="\n")
                w.writeheader()
                w.writerows(rows)
                z.writestr(f"{table}.txt", out.getvalue())
            for name, raw in self.other.items():
                z.writestr(name, raw)
        tmp.replace(self.path)


def restore_route(flat: Path, archive: Path, route_id: str) -> int:
    """Copy route_id's trips (with their stop times, frequencies, shapes and any missing
    stops) from archive into flat, if flat has no trips for it. Returns trips added."""
    feed = Tables(flat)
    if any(t["route_id"] == route_id for t in feed.rows("trips")):
        return 0
    if not any(r["route_id"] == route_id for r in feed.rows("routes")):
        raise ValueError(f"{flat.name}: no route {route_id} to restore trips for")
    with GtfsZip(archive) as old:
        trips = [t for t in old.rows("trips") if t["route_id"] == route_id]
        if not trips:
            raise ValueError(f"{archive.name}: has no trips for {route_id} either")
        ids = {t["trip_id"] for t in trips}
        shapes = {t["shape_id"] for t in trips if t.get("shape_id")}
        stop_times = [r for r in old.rows("stop_times") if r["trip_id"] in ids]
        frequencies = [r for r in old.rows("frequencies") if r["trip_id"] in ids]
        shape_rows = [r for r in old.rows("shapes") if r["shape_id"] in shapes]
        old_stops = {s["stop_id"]: s for s in old.rows("stops")}
    services = {c["service_id"] for c in feed.rows("calendar")}
    services |= {c["service_id"] for c in feed.rows("calendar_dates")}
    unknown = {t["service_id"] for t in trips} - services
    if unknown:
        raise ValueError(f"{flat.name}: restored trips use unknown services {sorted(unknown)}")

    have_stops = {s["stop_id"] for s in feed.rows("stops")}
    needed = {r["stop_id"] for r in stop_times}
    needed |= {old_stops[s]["parent_station"] for s in needed if old_stops[s].get("parent_station")}
    feed.rows("stops").extend(old_stops[s] for s in sorted(needed - have_stops))
    feed.rows("trips").extend(trips)
    feed.rows("stop_times").extend(stop_times)
    feed.rows("frequencies").extend(frequencies)
    have_shapes = {r["shape_id"] for r in feed.rows("shapes")}
    feed.rows("shapes").extend(r for r in shape_rows if r["shape_id"] not in have_shapes)
    feed.save()
    return len(trips)


def _fmt(seconds: int) -> str:
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def extend_route(flat: Path, ext: RouteExtension) -> int:
    """Add ext.stop_id to every trip of ext.route_id that starts or ends at ext.at_stop and
    does not serve it yet. Returns the number of trips changed."""
    feed = Tables(flat)
    trips = {t["trip_id"]: t for t in feed.rows("trips") if t["route_id"] == ext.route_id}
    by_trip: dict[str, list[dict[str, str]]] = {}
    for r in feed.rows("stop_times"):
        if r["trip_id"] in trips:
            by_trip.setdefault(r["trip_id"], []).append(r)
    shapes: dict[str, list[dict[str, str]]] = {}
    for r in feed.rows("shapes"):
        shapes.setdefault(r["shape_id"], []).append(r)
    names = {s["stop_id"]: s["stop_name"] for s in feed.rows("stops")}
    old_end = names.get(ext.at_stop, "")
    changed = 0
    done_shapes: set[str] = set()
    for trip_id, rows in by_trip.items():
        rows.sort(key=lambda r: int(r["stop_sequence"]))
        if any(r["stop_id"] == ext.stop_id for r in rows):
            continue
        first, last = rows[0], rows[-1]
        if first["stop_id"] == ext.at_stop:
            at_start = True
        elif last["stop_id"] == ext.at_stop:
            at_start = False
        else:
            continue
        new = {k: "" for k in first}
        new.update(trip_id=trip_id, stop_id=ext.stop_id)
        if at_start:
            # The new stop becomes the first: the rest of the trip runs ext.run_s later.
            for r in rows:
                for col in ("arrival_time", "departure_time"):
                    t = parse_time(r[col])
                    if t is not None:
                        r[col] = _fmt(t + ext.run_s)
            start = parse_time(first["departure_time"]) or ext.run_s  # shifted above
            new.update(
                arrival_time=_fmt(start - ext.run_s),
                departure_time=_fmt(start - ext.run_s),
                stop_sequence=str(int(first["stop_sequence"]) - 1),
            )
            if int(new["stop_sequence"]) < 0:
                for r in rows:
                    r["stop_sequence"] = str(int(r["stop_sequence"]) + 1)
                new["stop_sequence"] = "0"
        else:
            end = parse_time(last["arrival_time"]) or 0
            new.update(
                arrival_time=_fmt(end + ext.run_s),
                departure_time=_fmt(end + ext.run_s),
                stop_sequence=str(int(last["stop_sequence"]) + 1),
            )
        feed.rows("stop_times").append(new)
        changed += 1
        _rename_end(trips[trip_id], old_end, ext.name, towards=not at_start)

        shape_id = trips[trip_id].get("shape_id", "")
        points = shapes.get(shape_id)
        if points and shape_id not in done_shapes:
            done_shapes.add(shape_id)
            points.sort(key=lambda p: int(p["shape_pt_sequence"]))
            point = {k: "" for k in points[0]}
            point.update(shape_id=shape_id, shape_pt_lat=f"{ext.lat}", shape_pt_lon=f"{ext.lon}")
            has_dist = all(p.get("shape_dist_traveled") for p in points)
            dist_m = _straight_m(points[0] if at_start else points[-1], ext)
            if at_start:
                point["shape_pt_sequence"] = str(int(points[0]["shape_pt_sequence"]) - 1)
                if has_dist:
                    point["shape_dist_traveled"] = "0"
                    for p in points:
                        p["shape_dist_traveled"] = f"{float(p['shape_dist_traveled']) + dist_m:.3f}"
            else:
                point["shape_pt_sequence"] = str(int(points[-1]["shape_pt_sequence"]) + 1)
                if has_dist:
                    end_m = float(points[-1]["shape_dist_traveled"]) + dist_m
                    point["shape_dist_traveled"] = f"{end_m:.3f}"
            feed.rows("shapes").append(point)

    if not changed:
        return 0
    if not any(s["stop_id"] == ext.stop_id for s in feed.rows("stops")):
        stops = feed.rows("stops")
        template = next((s for s in stops if s["stop_id"] == ext.at_stop), stops[0])
        stop = {k: "" for k in template}
        stop.update(
            stop_id=ext.stop_id,
            stop_code=ext.stop_code,
            stop_name=ext.name,
            stop_lat=f"{ext.lat}",
            stop_lon=f"{ext.lon}",
            location_type="0",
            parent_station=ext.parent_station,
        )
        for col in ("zone_id", "stop_url", "stop_timezone"):
            if col in template:
                stop[col] = template[col]
        stops.append(stop)
    feed.save()
    return changed


def _rename_end(trip: dict[str, str], old: str, new: str, *, towards: bool) -> None:
    """The line's end moved from `old` to `new`: say so in the trip's headsign (only for
    trips going towards it) and in its "FROM-TO" short name."""
    if not old:
        return
    if towards and trip.get("trip_headsign", "").casefold() == old.casefold():
        trip["trip_headsign"] = new
    short = trip.get("trip_short_name", "")
    if old.casefold() in short.casefold():
        i = short.casefold().index(old.casefold())
        trip["trip_short_name"] = short[:i] + new + short[i + len(old) :]


def _straight_m(p: dict[str, str], ext: RouteExtension) -> float:
    lat, lon = float(p["shape_pt_lat"]), float(p["shape_pt_lon"])
    dy = (ext.lat - lat) * 111_320
    dx = (ext.lon - lon) * 111_320 * cos(radians(lat))
    return hypot(dx, dy)
