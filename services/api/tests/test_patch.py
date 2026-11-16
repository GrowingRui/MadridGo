"""Repairs for lines a feed leaves out or cuts short (app/ingest/patch.py): Metro Line 3
restored from CRTM's March 2025 file and extended to El Casar."""

import zipfile
from pathlib import Path

import pytest

from app.ingest.gtfs import GtfsZip
from app.ingest.patch import RouteExtension, extend_route, restore_route
from app.ingest.sources import SOURCES_BY_KEY

STOPS_H = "stop_id,stop_code,stop_name,stop_lat,stop_lon,zone_id,location_type,parent_station\n"
L1 = "4__1___"
L3 = "4__3___"


def feed(path: Path, *, l3: bool, extra_stop: bool = True) -> Path:
    """A tiny Metro: line 1 (A-B) and, if l3, line 3 with two frequency trips C<->D."""
    stops = STOPS_H + "par_A,1,A,40.40,-3.70,A,0,\npar_B,2,B,40.41,-3.70,A,0,\n"
    stops += "par_C,3,VILLAVERDE ALTO,40.34,-3.71,A,0,\n"
    if extra_stop:
        stops += "par_D,4,MONCLOA,40.43,-3.71,A,0,\n"
    trips = "route_id,service_id,trip_id,direction_id,shape_id,trip_headsign,trip_short_name\n"
    trips += f"{L1},WD,t1,0,s1,B,A-B\n"
    st = "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
    st += "t1,00:00:00,00:00:00,par_A,0\nt1,00:02:00,00:02:00,par_B,1\n"
    freq = "trip_id,start_time,end_time,headway_secs\nt1,06:00:00,23:00:00,300\n"
    shapes = "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\n"
    shapes += "s1,40.40,-3.70,1,0\ns1,40.41,-3.70,2,1100\n"
    if l3:
        trips += f"{L3},WD,up,0,s3up,MONCLOA,VILLAVERDE ALTO-MONCLOA\n"
        trips += f"{L3},WD,down,1,s3down,VILLAVERDE ALTO,MONCLOA-VILLAVERDE ALTO\n"
        st += "up,00:00:00,00:00:00,par_C,0\nup,00:30:00,00:30:00,par_D,1\n"
        st += "down,00:00:00,00:00:00,par_D,0\ndown,00:30:00,00:30:00,par_C,1\n"
        freq += "up,06:05:00,23:00:00,240\ndown,06:05:00,23:00:00,240\n"
        shapes += "s3up,40.34,-3.71,1000001,0\ns3up,40.43,-3.71,1000002,10000\n"
        shapes += "s3down,40.43,-3.71,1000001,0\ns3down,40.34,-3.71,1000002,10000\n"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("agency.txt", "agency_id,agency_name\nCRTM,CRTM\n")
        z.writestr("routes.txt", f"route_id,route_short_name\n{L1},1\n{L3},3\n")
        z.writestr("stops.txt", stops)
        z.writestr("trips.txt", trips)
        z.writestr("stop_times.txt", st)
        z.writestr("frequencies.txt", freq)
        z.writestr("shapes.txt", shapes)
        z.writestr(
            "calendar.txt", "service_id,monday,start_date,end_date\nWD,1,20250101,20260527\n"
        )
    return path


def rows(path: Path, table: str) -> list[dict[str, str]]:
    with GtfsZip(path) as f:
        return list(f.rows(table))


def trip_stops(path: Path, trip: str) -> list[tuple[str, str, str]]:
    st = [r for r in rows(path, "stop_times") if r["trip_id"] == trip]
    st.sort(key=lambda r: int(r["stop_sequence"]))
    return [(r["stop_id"], r["arrival_time"], r["stop_sequence"]) for r in st]


EL_CASAR = RouteExtension(
    route_id=L3,
    at_stop="par_C",
    stop_id="par_E",
    stop_code="349",
    name="EL CASAR",
    lat=40.3186,
    lon=-3.7095,
    run_s=445,
    parent_station="est_X",
)


def test_a_line_without_trips_gets_them_back_from_the_older_file(tmp_path: Path) -> None:
    current = feed(tmp_path / "may.zip", l3=False, extra_stop=False)
    archive = feed(tmp_path / "march.zip", l3=True)
    assert restore_route(current, archive, L3) == 2
    assert {t["trip_id"] for t in rows(current, "trips")} == {"t1", "up", "down"}
    assert trip_stops(current, "up") == [("par_C", "00:00:00", "0"), ("par_D", "00:30:00", "1")]
    assert {r["trip_id"] for r in rows(current, "frequencies")} == {"t1", "up", "down"}
    assert {r["shape_id"] for r in rows(current, "shapes")} == {"s1", "s3up", "s3down"}
    # A stop only the old file has is brought along; the others are not duplicated.
    assert sorted(s["stop_id"] for s in rows(current, "stops")) == [
        "par_A",
        "par_B",
        "par_C",
        "par_D",
    ]
    assert rows(current, "agency") == [{"agency_id": "CRTM", "agency_name": "CRTM"}]


def test_a_line_that_has_trips_is_left_as_published(tmp_path: Path) -> None:
    current = feed(tmp_path / "new.zip", l3=True)
    before = current.read_bytes()
    assert restore_route(current, feed(tmp_path / "march.zip", l3=True), L3) == 0
    assert current.read_bytes() == before


def test_restored_trips_must_use_services_the_feed_has(tmp_path: Path) -> None:
    current = feed(tmp_path / "may.zip", l3=False)
    archive = feed(tmp_path / "march.zip", l3=True)
    # Replace the calendar: service WD no longer exists.
    data = {n: zipfile.ZipFile(current).read(n) for n in zipfile.ZipFile(current).namelist()}
    data["calendar.txt"] = b"service_id,monday,start_date,end_date\nOTHER,1,20250101,20260527\n"
    with zipfile.ZipFile(current, "w") as z:
        for n, b in data.items():
            z.writestr(n, b)
    with pytest.raises(ValueError, match="unknown services"):
        restore_route(current, archive, L3)


def test_extension_adds_the_new_end_stop_in_both_directions(tmp_path: Path) -> None:
    metro = feed(tmp_path / "metro.zip", l3=True)
    assert extend_route(metro, EL_CASAR) == 2
    # Starting at Villaverde Alto: El Casar comes first and the rest runs 445 s later, so
    # the frequency window now counts from El Casar.
    assert trip_stops(metro, "up") == [
        ("par_E", "00:00:00", "0"),
        ("par_C", "00:07:25", "1"),
        ("par_D", "00:37:25", "2"),
    ]
    # Ending at Villaverde Alto: El Casar 445 s after it.
    assert trip_stops(metro, "down")[-1] == ("par_E", "00:37:25", "2")
    assert trip_stops(metro, "t1") == [("par_A", "00:00:00", "0"), ("par_B", "00:02:00", "1")]
    stop = next(s for s in rows(metro, "stops") if s["stop_id"] == "par_E")
    assert (stop["stop_name"], stop["stop_code"], stop["zone_id"]) == ("EL CASAR", "349", "A")
    assert stop["location_type"] == "0" and stop["parent_station"] == "est_X"
    # Destinations name the new end; trips away from it keep theirs.
    trips = {t["trip_id"]: t for t in rows(metro, "trips")}
    assert (trips["down"]["trip_headsign"], trips["down"]["trip_short_name"]) == (
        "EL CASAR",
        "MONCLOA-EL CASAR",
    )
    assert (trips["up"]["trip_headsign"], trips["up"]["trip_short_name"]) == (
        "MONCLOA",
        "EL CASAR-MONCLOA",
    )
    assert trips["t1"]["trip_headsign"] == "B"
    # Shapes reach the new stop (straight), with distances shifted on the shape that starts
    # there (about 2.6 km from (40.34, -3.71) to the test point).
    up = sorted(
        (r for r in rows(metro, "shapes") if r["shape_id"] == "s3up"),
        key=lambda r: int(r["shape_pt_sequence"]),
    )
    assert (up[0]["shape_pt_lat"], up[0]["shape_dist_traveled"]) == ("40.3186", "0")
    assert 2300 < float(up[1]["shape_dist_traveled"]) < 2600
    # Full precision kept: rounding made close points share a distance (validator error).
    assert up[1]["shape_dist_traveled"].split(".")[1].__len__() == 3
    down = [r for r in rows(metro, "shapes") if r["shape_id"] == "s3down"]
    assert max(int(r["shape_pt_sequence"]) for r in down) == 1000003
    # Applying it again changes nothing.
    assert extend_route(metro, EL_CASAR) == 0


def test_metro_is_configured_to_restore_line_3_and_extend_it_to_el_casar() -> None:
    metro = SOURCES_BY_KEY["metro"]
    assert [r.route_id for r in metro.restore_routes] == [L3]
    assert metro.restore_routes[0].url.endswith("mdb-794-202503270057.zip")
    ext = metro.extend_routes[0]
    assert (ext.route_id, ext.at_stop, ext.stop_id, ext.name) == (
        L3,
        "par_4_273",
        "par_4_349",
        "EL CASAR",
    )
