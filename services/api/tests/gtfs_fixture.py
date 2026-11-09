"""Builds a tiny GTFS zip for tests: one station with a platform, a bus stop and a terminus.

Line T1 runs at fixed times; line F2 is frequency-based (every 10 min, 07:00-09:00).
Files sit in a subfolder, like CRTM's interurban zip, to exercise prefix detection.
"""

import zipfile
from pathlib import Path

FILES = {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nA,Test,https://example.org,Europe/Madrid\n",
    "stops.txt": (
        "stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station\n"
        "est_99_1,1,ESTACIÓN DE TESTVILLE,40.40,-3.70,1,\n"
        "par_99_1,1,ESTACIÓN DE TESTVILLE,40.4001,-3.7001,0,\n"  # linked by naming convention
        "par_99_2,2,AV.PRUEBA-CALLE MAYOR,40.41,-3.71,0,\n"
        "par_99_3,3,Terminal Norte,40.42,-3.72,0,\n"
    ),
    "routes.txt": (
        "route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n"
        "T1,A,T1,Testville - Norte,2,#ff0000,ffffff\n"
        "F2,A,F2,Prueba - Norte,3,00AA00,FFFFFF\n"
    ),
    "trips.txt": (
        "route_id,service_id,trip_id,trip_headsign,direction_id\n"
        "T1,ALL,t1_a,,0\n"
        "T1,ALL,t1_b,,0\n"
        "F2,ALL,f2_a,Terminal Norte,0\n"
    ),
    "stop_times.txt": (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        "t1_a,08:00:00,08:00:00,par_99_1,1\n"
        "t1_a,08:10:00,08:10:00,par_99_3,2\n"
        "t1_b,25:30:00,25:30:00,par_99_1,1\n"  # 01:30 next morning, on the previous service day
        "t1_b,25:40:00,25:40:00,par_99_3,2\n"
        "f2_a,7:00:00,7:00:00,par_99_2,1\n"
        "f2_a,7:05:00,7:05:00,par_99_3,2\n"
    ),
    "frequencies.txt": (
        "trip_id,start_time,end_time,headway_secs\n"
        "f2_a,7:00:00,8:59:59,600\n"
        "f2_a,9:00:00,9:59:59,900\n"  # back-to-back window: "until" must span both
    ),
    "calendar.txt": (
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
        "ALL,1,1,1,1,1,1,1,20260101,20271231\n"
    ),
    "calendar_dates.txt": "service_id,date,exception_type\nALL,20261225,2\n",
    "feed_info.txt": (
        "feed_publisher_name,feed_publisher_url,feed_lang,feed_version\n"
        "T,https://example.org,es,20261101\nT,https://example.org,es,20261102\n"
    ),
}


def build(
    path: Path, prefix: str = "google_transit_X/", overrides: dict[str, str] | None = None
) -> Path:
    files = {**FILES, **(overrides or {})}
    with zipfile.ZipFile(path, "w") as z:
        if prefix:
            z.writestr(prefix, "")
        for name, body in files.items():
            z.writestr(prefix + name, body.encode("utf-8"))
    return path
