"""Repair the trip shapes of a GTFS feed so OpenTripPlanner draws trains along the tracks.

Renfe's Cercanías feed has one shape per line and direction (10_C4b and 10_C4b_INV, the same
track the other way round), but many trips use the one for the other direction. OTP then
cannot find the stations one after another along the shape and draws the trip as straight
lines between stations ("ShapeGeometryTooFar" in its build report). Some shapes also leave
out a branch, so a few trips are kilometres away from their shape.

For each trip pattern (shape and stop list) this keeps the shape when it fits, else uses it
the other way round when that fits. Else it stitches a new shape from station to station: each
hop follows the shortest piece of any shape (either way round) that has both stations, e.g. a
C1 train from Atocha takes the C2/C8 tunnel to Chamartín and then C1's own track to the
airport. A hop no shape has stays a straight line; a pattern with no such piece at all loses its
shape_id (OTP draws it straight, as before). "Fits" means every station lies within `max_m`
metres of the shape, in the trip's order (OTP's own limit is 150 m).
"""

import csv
import hashlib
import io
import os
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from math import cos, hypot, radians
from pathlib import Path

LatLon = tuple[float, float]

# OTP's default for how far a stop may be from its trip's shape.
MAX_STOP_TO_SHAPE_M = 150.0
_M_PER_DEG = 111_320.0


@dataclass
class ShapeRepair:
    patterns: int = 0
    kept: int = 0  # patterns whose shape already fitted
    reversed: int = 0  # patterns given the shape the other way round
    stitched: int = 0  # patterns given a shape made of pieces of other shapes
    straight_hops: int = 0  # station-to-station hops of stitched shapes that no shape has
    dropped: int = 0  # patterns left without a shape (drawn straight)
    trips_changed: int = 0


def _xy(shape: list[LatLon]) -> tuple[float, list[tuple[float, float]]]:
    kx = _M_PER_DEG * cos(radians(shape[0][0]))
    return kx, [(lon * kx, lat * _M_PER_DEG) for lat, lon in shape]


def locate(
    stops: list[LatLon], shape: list[LatLon], max_m: float = MAX_STOP_TO_SHAPE_M
) -> list[float] | None:
    """Where each stop lies along the shape (segment index + fraction), each at or after the
    previous; None when a stop is more than max_m from the rest of the shape."""
    if len(shape) < 2 or not stops:
        return None
    kx, pts = _xy(shape)
    at = 0.0
    found: list[float] = []
    for lat, lon in stops:
        px, py = lon * kx, lat * _M_PER_DEG
        best: tuple[float, float] | None = None  # (distance, position)
        for i in range(int(at), len(pts) - 1):
            (ax, ay), (bx, by) = pts[i], pts[i + 1]
            dx, dy = bx - ax, by - ay
            length2 = dx * dx + dy * dy
            t = 0.0 if length2 == 0 else ((px - ax) * dx + (py - ay) * dy) / length2
            t = max(0.0, min(1.0, t))
            if i + t < at:  # not backwards along the shape
                t = at - i
            d = hypot(ax + t * dx - px, ay + t * dy - py)
            if best is None or d < best[0]:
                best = (d, i + t)
        if best is None or best[0] > max_m:
            return None
        at = best[1]
        found.append(at)
    return found


def fits(stops: list[LatLon], shape: list[LatLon], max_m: float = MAX_STOP_TO_SHAPE_M) -> bool:
    """True when every stop lies within max_m of the shape, each one at or after the
    previous along it."""
    return locate(stops, shape, max_m) is not None


def _point(shape: list[LatLon], at: float) -> LatLon:
    i = min(int(at), len(shape) - 2)
    t = at - i
    (a_lat, a_lon), (b_lat, b_lon) = shape[i], shape[i + 1]
    return (a_lat + (b_lat - a_lat) * t, a_lon + (b_lon - a_lon) * t)


def piece(shape: list[LatLon], start: float, end: float) -> list[LatLon]:
    """The part of the shape between two positions (segment index + fraction)."""
    inner = [shape[i] for i in range(int(start) + 1, int(end) + 1) if start < i < end]
    return [_point(shape, start), *inner, _point(shape, end)]


def length_m(line: list[LatLon]) -> float:
    if len(line) < 2:
        return 0.0
    _, pts = _xy(line)
    return sum(hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:], strict=False))


# A piece of track between two stations may be this much longer than the straight line
# (plus a little for stations close together); longer means a shape passing both stations
# some other way, e.g. round a loop.
_MAX_DETOUR = 2.5
_DETOUR_SLACK_M = 500.0


def stitch(
    stops: list[LatLon], shapes: list[list[LatLon]], max_m: float = MAX_STOP_TO_SHAPE_M
) -> tuple[list[LatLon], int, int]:
    """A shape through the stops made of pieces of the given shapes (each also tried the
    other way round): per hop, the shortest piece that has both stations. Returns the shape,
    the number of hops found on a shape and the number left straight."""
    candidates = [s for s in shapes if len(s) >= 2]
    candidates += [s[::-1] for s in candidates]
    line: list[LatLon] = []
    on_track = straight = 0
    for a, b in zip(stops, stops[1:], strict=False):
        limit = length_m([a, b]) * _MAX_DETOUR + _DETOUR_SLACK_M
        best: list[LatLon] | None = None
        for shape in candidates:
            at = locate([a, b], shape, max_m)
            if at is None:
                continue
            part = piece(shape, at[0], at[1])
            size = length_m(part)
            if size <= limit and (best is None or size < length_m(best)):
                best = part
        if best is None:
            best = [a, b]
            straight += 1
        else:
            on_track += 1
        line.extend(best if not line else best[1:] if line[-1] == best[0] else best)
    return line, on_track, straight


def _read(z: zipfile.ZipFile, name: str) -> tuple[list[str], list[dict[str, str]]]:
    with z.open(name) as raw:
        reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
        rows = list(reader)
        return list(reader.fieldnames or []), rows


def _csv(fields: list[str], rows: list[dict[str, str]]) -> bytes:
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=fields, lineterminator="\n")
    w.writeheader()
    w.writerows(rows)
    return out.getvalue().encode("utf-8")


def repair_shapes(path: Path, max_m: float = MAX_STOP_TO_SHAPE_M) -> ShapeRepair:
    """Rewrite trips.txt (and shapes.txt, when a reversed shape has to be added) of the
    GTFS zip at `path` in place. The zip must have its files at the root."""
    result = ShapeRepair()
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        if not {"trips.txt", "shapes.txt", "stop_times.txt", "stops.txt"} <= names:
            return result
        trip_fields, trips = _read(z, "trips.txt")
        shape_fields, shape_rows = _read(z, "shapes.txt")
        _, stop_rows = _read(z, "stops.txt")
        _, stop_times = _read(z, "stop_times.txt")

    stops: dict[str, LatLon] = {}
    for s in stop_rows:
        try:
            stops[s["stop_id"]] = (float(s["stop_lat"]), float(s["stop_lon"]))
        except (KeyError, ValueError):
            continue
    points: dict[str, list[tuple[int, LatLon]]] = defaultdict(list)
    for r in shape_rows:
        points[r["shape_id"]].append(
            (int(r["shape_pt_sequence"]), (float(r["shape_pt_lat"]), float(r["shape_pt_lon"])))
        )
    shapes = {k: [p for _, p in sorted(v)] for k, v in points.items()}
    by_coords = {tuple(v): k for k, v in shapes.items()}
    sequences: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for r in stop_times:
        sequences[r["trip_id"]].append((int(r["stop_sequence"]), r["stop_id"]))

    added: dict[str, list[LatLon]] = {}
    decided: dict[tuple[str, tuple[str, ...]], str] = {}  # pattern -> new shape_id ("" = none)
    for trip in trips:
        shape_id = trip.get("shape_id") or ""
        seq = tuple(s for _, s in sorted(sequences.get(trip["trip_id"], [])))
        if not shape_id or not seq:
            continue
        key = (shape_id, seq)
        if key not in decided:
            result.patterns += 1
            coords = [stops[s] for s in seq if s in stops]
            shape = shapes.get(shape_id, [])
            if fits(coords, shape, max_m):
                decided[key] = shape_id
                result.kept += 1
            elif fits(coords, shape[::-1], max_m):
                back = shape[::-1]
                other = by_coords.get(tuple(back))
                if other is None:
                    other = f"{shape_id}_rev"
                    added[other] = back
                    by_coords[tuple(back)] = other
                decided[key] = other
                result.reversed += 1
            else:
                line, on_track, straight = stitch(coords, list(shapes.values()), max_m)
                if on_track and fits(coords, line, max_m):
                    digest = hashlib.sha256("|".join(seq).encode()).hexdigest()[:10]
                    other = by_coords.get(tuple(line)) or f"stitched_{digest}"
                    if other not in shapes and other not in added:
                        added[other] = line
                        by_coords[tuple(line)] = other
                    decided[key] = other
                    result.stitched += 1
                    result.straight_hops += straight
                else:
                    decided[key] = ""
                    result.dropped += 1
        new = decided[key]
        if new != shape_id:
            trip["shape_id"] = new
            result.trips_changed += 1

    if not result.trips_changed:
        return result
    for shape_id, coords in added.items():
        for i, (lat, lon) in enumerate(coords, start=1):
            shape_rows.append(
                {
                    "shape_id": shape_id,
                    "shape_pt_lat": f"{lat}",
                    "shape_pt_lon": f"{lon}",
                    "shape_pt_sequence": str(i),
                }
            )
    # shape_dist_traveled and other optional columns stay empty on added points.
    replaced = {"trips.txt": _csv(trip_fields, trips)}
    if added:
        replaced["shapes.txt"] = _csv(shape_fields, shape_rows)
    tmp = path.with_suffix(".tmp")
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = replaced.get(info.filename)
            if data is None:
                data = zin.read(info)
            zout.writestr(info.filename, data)
    os.replace(tmp, path)
    return result
