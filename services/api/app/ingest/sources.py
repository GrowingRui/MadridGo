"""Registry of static data sources (see docs/DATA_SOURCE_ANALYSIS.md)."""

from dataclasses import dataclass

ARCGIS_ITEM = "https://www.arcgis.com/sharing/rest/content/items/{item}/data"
CRTM_LICENCE = "https://www.crtm.es/licencia-de-uso"
# Renfe's own Cercanías GTFS (all of Spain's networks, CC BY 4.0). Renfe publishes it
# before CRTM republishes the Madrid part, so it is the source for Madrid Cercanías.
RENFE_CERCANIAS_URL = "https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip"
RENFE_CERCANIAS_LICENCE = "https://data.renfe.com/dataset/horarios-cercanias"


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


def _crtm(
    key: str, name: str, mode: str, item: str, namespace: str = "crtm", warn: int = 14
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
    )


# CRTM republishes EMT's GTFS, so the separate EMT download is not used (it would
# duplicate every EMT trip in OTP).
GTFS_SOURCES: tuple[GtfsSource, ...] = (
    _crtm("metro", "Metro de Madrid", "metro", "5c7f2951962540d69ffe8f640d94c246"),
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
    ),
    _crtm("interurban", "CRTM Autobuses interurbanos", "bus", "885399f83408473c8d815e40c5e702b7"),
    _crtm("urban", "CRTM Autobuses urbanos", "bus", "357e63c2904f43aeb5d8a267a64346d8"),
    _crtm("emt", "EMT Madrid", "bus", "868df0e58fca47e79b942902dffd7da0", namespace="emt"),
)

SOURCES_BY_KEY = {s.key: s for s in GTFS_SOURCES}

# Street network for OTP walking legs. Geofabrik redirects "latest" to a dated file.
OSM_MADRID_URL = "https://download.geofabrik.de/europe/spain/madrid-latest.osm.pbf"
