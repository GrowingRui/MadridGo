"""Registry of static data sources (see docs/DATA_SOURCE_ANALYSIS.md)."""

from dataclasses import dataclass

from app.ingest.patch import RouteExtension, RouteRestore

ARCGIS_ITEM = "https://www.arcgis.com/sharing/rest/content/items/{item}/data"
CRTM_LICENCE = "https://www.crtm.es/licencia-de-uso"
# Renfe's own Cercanías GTFS (all of Spain's networks, CC BY 4.0). Renfe publishes it
# before CRTM republishes the Madrid part, so it is the source for Madrid Cercanías.
RENFE_CERCANIAS_URL = "https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip"
RENFE_CERCANIAS_LICENCE = "https://data.renfe.com/dataset/horarios-cercanias"
# CRTM's Metro GTFS of March 2025 (service 2025-03-26 -> 2026-03-26), as kept by Mobility
# Database. Source of Line 3, which CRTM's later file leaves without trips.
# CRTM's network map (open-data portal, same licence): stops of every current itinerary.
CRTM_NETWORK_LAYER = (
    "https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services/{}/FeatureServer/3"
)
METRO_MARCH_2025_URL = (
    "https://files.mobilitydatabase.org/mdb-794/mdb-794-202503270057/mdb-794-202503270057.zip"
)


@dataclass(frozen=True)
class GtfsSource:
    key: str  # short, stable identifier; also the prefix of global IDs
    operator_name: str
    mode: str  # metro | light_rail | rail | bus
    url: str
    licence_url: str
    attribution: str
    # Prefix of global stop IDs. CRTM stop IDs (par_8_16825, est_90_21) are unique across
    # all CRTM feeds, so CRTM feeds share one namespace: a stop listed in both the
    # interurban and urban feeds is the same stop.
    id_namespace: str
    # Warn this many days before the calendar ends.
    expiry_warning_days: int = 14
    # Keep only routes whose route_id starts with this (and the trips, stops, calendars and
    # shapes they use). For feeds covering more than Madrid.
    route_prefix: str | None = None
    # Give each trip a shape that fits its stops, or none (app/ingest/shapes.py). For feeds
    # whose trips use the shape of the other direction, so OTP would draw them straight.
    repair_shapes: bool = False
    # Stops the feed puts in the wrong place: (stop_id, lat, lon) to use instead. Applied
    # when the feed is cut down (route_prefix), so only for such feeds.
    stop_positions: tuple[tuple[str, float, float], ...] = ()
    # Key of a current feed whose calendar replaces this feed's once this one has run out
    # (app/ingest/carry.py). The times are then an estimate and the app says so.
    calendar_from: str | None = None
    # Lines the feed leaves out or cuts short (app/ingest/patch.py), applied before the
    # calendar is carried forward. Each acts only while the feed still has the gap.
    restore_routes: tuple[RouteRestore, ...] = ()
    extend_routes: tuple[RouteExtension, ...] = ()
    # Map layer listing the stops of each line (app/ingest/untimed.py): where lines the feed
    # gives no trips stop, so boards and journeys there can say they are missing.
    network_layer: str | None = None


def _crtm(
    key: str,
    name: str,
    mode: str,
    item: str,
    namespace: str = "crtm",
    warn: int = 14,
    calendar_from: str | None = None,
    restore_routes: tuple[RouteRestore, ...] = (),
    extend_routes: tuple[RouteExtension, ...] = (),
    network_layer: str | None = None,
) -> GtfsSource:
    return GtfsSource(
        key=key,
        operator_name=name,
        mode=mode,
        url=ARCGIS_ITEM.format(item=item),
        licence_url=CRTM_LICENCE,
        attribution="Powered by CRTM",
        id_namespace=namespace,
        expiry_warning_days=warn,
        calendar_from=calendar_from,
        restore_routes=restore_routes,
        extend_routes=extend_routes,
        network_layer=network_layer,
    )


# CRTM republishes EMT's GTFS, so the separate EMT download is not used (it would
# duplicate every EMT trip in OTP).
GTFS_SOURCES: tuple[GtfsSource, ...] = (
    # Metro: CRTM's last file ended 2026-05-27 and CRTM can't say when a new one will come
    # (reply of 2026-11-16), so it runs on Metro Ligero's calendar: same publisher, same day
    # types and holidays. Labelled as an estimate in the app.
    _crtm(
        "metro",
        "Metro de Madrid",
        "metro",
        "5c7f2951962540d69ffe8f640d94c246",
        calendar_from="ml",
        # Line 3: CRTM's May 2025 file has the line but no trips (its 18 stations had no
        # service); the March 2025 file, otherwise identical, has them. Kept by Mobility
        # Database (feed mdb-794); found 2026-11-16 from a user report (San Fermín-Orcasur).
        restore_routes=(
            RouteRestore(
                route_id="4__3___",
                url=METRO_MARCH_2025_URL,
                sha256="6930d31dd6c0bcdafab665f7d1ea2c34f37db06b8def6034e6008b8241ed46db",
            ),
        ),
        # Line 3 runs on from Villaverde Alto to El Casar since 2025-04-21 (CRTM network
        # layer M4_Red, station 349; the March file predates it). Run time from CRTM's
        # section data: 2,978-3,007 m at 24.99 km/h = 433 s, plus 12 s dwell (the same
        # formula gives the timetable's next section within 12 s). Station point from
        # M4_Estaciones.
        extend_routes=(
            RouteExtension(
                route_id="4__3___",
                at_stop="par_4_273",
                stop_id="par_4_349",
                stop_code="349",
                name="EL CASAR",
                lat=40.3185577,
                lon=-3.7095030,
                run_s=445,
                # One interchange with Line 12's El Casar (est_4_228).
                parent_station="est_4_228",
            ),
        ),
    ),
    _crtm("ml", "Metro Ligero", "light_rail", "aaed26cc0ff64b0c947ac0bc3e033196"),
    # Cercanías: Renfe's national feed cut down to the Madrid network (route IDs "10…"),
    # about one month of validity. CRTM's copy (item 1a25440bf66f499bae2657ec7fb40144) is
    # the same data with the same IDs, but republished later.
    GtfsSource(
        key="cercanias",
        operator_name="Renfe Cercanías",
        mode="rail",
        url=RENFE_CERCANIAS_URL,
        licence_url=RENFE_CERCANIAS_LICENCE,
        attribution="Renfe open data (CC BY 4.0)",
        id_namespace="renfe",
        expiry_warning_days=7,
        route_prefix="10",
        repair_shapes=True,
        # Vallecas: Renfe's feed has it 140 m east of the station (found 2026-11-12, user
        # report); CRTM's copy (stop 70001) and OpenStreetMap (node 5320204129) agree on
        # this place. The other 94 Madrid stations match CRTM's copy exactly.
        stop_positions=(("70005", 40.3819607, -3.6245835),),
    ),
    # Both bus feeds list lines without trips (2026-11-16: interurban 720-728, N702, 635,
    # N908; urban Colmenar Viejo 1 and 2, Getafe 3A, Valdemoro SE, Algete I1), also in every
    # archived copy since November 2025. Their stops come from CRTM's network map.
    _crtm(
        "interurban",
        "CRTM Autobuses interurbanos",
        "bus",
        "885399f83408473c8d815e40c5e702b7",
        network_layer=CRTM_NETWORK_LAYER.format("M8_Red"),
    ),
    _crtm(
        "urban",
        "CRTM Autobuses urbanos",
        "bus",
        "357e63c2904f43aeb5d8a267a64346d8",
        network_layer=CRTM_NETWORK_LAYER.format("M9_Red"),
    ),
    _crtm("emt", "EMT Madrid", "bus", "868df0e58fca47e79b942902dffd7da0", namespace="emt"),
)

SOURCES_BY_KEY = {s.key: s for s in GTFS_SOURCES}

# Street network for OTP walking legs. Geofabrik redirects "latest" to a dated file.
OSM_MADRID_URL = "https://download.geofabrik.de/europe/spain/madrid-latest.osm.pbf"
