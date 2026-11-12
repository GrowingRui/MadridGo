"""Shape repair for Renfe's Cercanías feed (app/ingest/shapes.py)."""

import csv
import io
import zipfile
from pathlib import Path

from app.ingest.shapes import fits, length_m, repair_shapes, stitch

# A straight north-south track, south end first: about 1.1 km per 0.01° of latitude.
TRACK = [(40.20 + i * 0.01, -3.70) for i in range(6)]  # 40.20 .. 40.25
STOPS = {"S": (40.2005, -3.7001), "M": (40.2251, -3.6999), "N": (40.2498, -3.7002)}
FAR = {"X": (40.225, -3.60)}  # about 8.5 km east of the track
# The same track drawn 25 m further east, north end first, with no shape for the other way.
ONE_WAY = [(lat, -3.6997) for lat, _ in TRACK[::-1]]


def test_fits_needs_stops_close_and_in_order() -> None:
    north = [STOPS["S"], STOPS["M"], STOPS["N"]]
    assert fits(north, TRACK)
    assert not fits(north[::-1], TRACK)  # the other direction
    assert fits(north[::-1], TRACK[::-1])
    assert not fits([STOPS["S"], FAR["X"]], TRACK)
    assert not fits(north, TRACK[:1])  # one point is not a shape


def _write(path: Path, tables: dict[str, list[dict[str, str]]]) -> Path:
    with zipfile.ZipFile(path, "w") as z:
        for name, rows in tables.items():
            out = io.StringIO()
            w = csv.DictWriter(out, fieldnames=list(rows[0]), lineterminator="\n")
            w.writeheader()
            w.writerows(rows)
            z.writestr(f"{name}.txt", out.getvalue())
    return path


def _rows(path: Path, name: str) -> list[dict[str, str]]:
    with zipfile.ZipFile(path) as z:
        return list(csv.DictReader(io.TextIOWrapper(z.open(f"{name}.txt"), encoding="utf-8")))


def _shape(shape_id: str, coords: list[tuple[float, float]]) -> list[dict[str, str]]:
    return [
        {
            "shape_id": shape_id,
            "shape_pt_lat": str(a),
            "shape_pt_lon": str(b),
            "shape_pt_sequence": str(i),
        }
        for i, (a, b) in enumerate(coords, start=1)
    ]


def _times(trip: str, stops: str) -> list[dict[str, str]]:
    return [{"trip_id": trip, "stop_sequence": str(i), "stop_id": s} for i, s in enumerate(stops)]


def test_repair_swaps_reversed_shapes_and_drops_bad_ones(tmp_path: Path) -> None:
    stops = [
        {"stop_id": k, "stop_lat": str(a), "stop_lon": str(b)}
        for k, (a, b) in (STOPS | FAR).items()
    ]
    trips = [
        {"trip_id": "north_ok", "shape_id": "UP"},
        {"trip_id": "south_on_up", "shape_id": "UP"},  # Renfe: the wrong direction
        {"trip_id": "north_on_one_way", "shape_id": "ONE"},  # no other direction in the feed
        {"trip_id": "off_track", "shape_id": "UP"},
        {"trip_id": "no_shape", "shape_id": ""},
    ]
    feed = _write(
        tmp_path / "f.zip",
        {
            "stops": stops,
            "trips": trips,
            "shapes": _shape("UP", TRACK) + _shape("DOWN", TRACK[::-1]) + _shape("ONE", ONE_WAY),
            "stop_times": _times("north_ok", "SMN")
            + _times("south_on_up", "NMS")
            + _times("north_on_one_way", "SMN")
            + _times("off_track", "SXN")
            + _times("no_shape", "SN"),
        },
    )

    result = repair_shapes(feed)

    assert (result.patterns, result.kept, result.reversed, result.dropped) == (4, 1, 2, 1)
    shape_of = {t["trip_id"]: t["shape_id"] for t in _rows(feed, "trips")}
    assert shape_of == {
        "north_ok": "UP",
        "south_on_up": "DOWN",  # the feed's own shape for that direction
        "north_on_one_way": "ONE_rev",  # added, ONE the other way round
        "off_track": "",  # drawn straight rather than along a wrong track
        "no_shape": "",
    }
    added = [r for r in _rows(feed, "shapes") if r["shape_id"] == "ONE_rev"]
    assert [(float(r["shape_pt_lat"]), float(r["shape_pt_lon"])) for r in added] == ONE_WAY[::-1]
    # Running it again changes nothing.
    assert repair_shapes(feed).trips_changed == 0


def test_repair_leaves_feeds_without_shapes_alone(tmp_path: Path) -> None:
    feed = _write(tmp_path / "f.zip", {"trips": [{"trip_id": "t", "shape_id": ""}]})
    before = feed.read_bytes()
    assert repair_shapes(feed).patterns == 0
    assert feed.read_bytes() == before


def test_stitch_joins_pieces_of_other_shapes() -> None:
    # Line A runs north S -> N; line B runs east from N to E. A trip S -> N -> E has no shape
    # of its own, and a hop E -> F that no shape has stays straight.
    east = [(40.25, -3.70 + i * 0.01) for i in range(4)]  # N .. 2.5 km east
    s, n, e, f = STOPS["S"], STOPS["N"], (40.2502, -3.68), (40.27, -3.68)
    line, on_track, straight = stitch([s, n, e, f], [TRACK, east[::-1]])
    assert (on_track, straight) == (2, 1)
    assert fits([s, n, e, f], line)
    assert line[-1] == f
    assert (40.25, -3.70) in line  # the corner of the two tracks
    assert length_m(line) < 1.1 * (length_m([s, n]) + length_m([n, e]) + length_m([e, f]))


def test_stitch_skips_a_shape_going_far_round() -> None:
    # A loop that passes both stations, but 10 km round: a straight line is better.
    loop = [(40.20, -3.70), (40.20, -3.60), (40.30, -3.60), (40.30, -3.70), (40.21, -3.70)]
    line, on_track, straight = stitch([(40.30, -3.70), (40.21, -3.70)], [loop])
    assert (on_track, straight) == (1, 0)  # the loop's last side goes straight there
    line, on_track, straight = stitch([(40.20, -3.70), (40.21, -3.70)], [loop])
    assert (on_track, straight) == (0, 1)
