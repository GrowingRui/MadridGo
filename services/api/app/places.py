"""Address and place search (`GET /places/search`, Phase 5 second round item 4).

Stops come from our own timetables (`/stops/search`); this finds everything else: street
addresses ("Calle Mayor 5"), streets ("Calle Real, Parla") and named places ("Hospital 12 de
Octubre", "Museo del Prado"). The planner then plans from or to the place's point, as it does
for "Current location".

Geocoder: CartoCiudad (https://www.cartociudad.es), the Spanish government's address service
(Instituto Geográfico Nacional). Chosen over Photon / Nominatim (OpenStreetMap) because:
- it answers in well under a second; on 2026-11-12 the public Photon server took 35-40 s per
  query, and Nominatim's usage policy forbids search-as-you-type on its public server;
- its address points are official (street map and cadastre), down to the building number,
  and it also has named places (hospitals, museums, stadiums, shops);
- no key, no account, no fair-use quota; data under CC BY 4.0 (credit in the About page).
Its weak spot is ranking: it does not prefer results near a point, so "Calle Mayor 5" lists
the street of every town that has one. We ask only for the Comunidad de Madrid and then list
equal names nearest first (to the point the app sends, else Puerta del Sol). Typing the town
("calle real 10 parla") finds the right one first.

Answers are cached for a week. Public transport stops that CartoCiudad also lists are left
out: the stop search lists them with their lines, from the operators' own data.
"""

import asyncio
import hashlib
import logging
import math
import re
from dataclasses import dataclass
from typing import Annotated, Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, TypeAdapter

from app import __version__
from app.config import get_settings
from app.i18n import tr
from app.realtime.cache import KV, get_kv

log = logging.getLogger(__name__)

router = APIRouter(tags=["places"])

# The area MadridGo plans in (as /journeys' from_lat/from_lon): west, south, east, north.
BBOX = (-4.6, 39.8, -3.0, 41.2)
# Equal names are listed nearest first to this point (Puerta del Sol) unless the app sends one.
CENTRE = (40.4169, -3.7035)
CACHE_TTL_S = 7 * 24 * 3600
LIMIT = 8
# Ask for more than we show: some answers are stops or kinds we leave out.
FETCH = 20
# Streets come without a point; each one costs a second request, so only the first few.
MAX_STREETS = 4

PlaceKind = Literal["address", "street", "place", "area"]

# CartoCiudad result types -> our kinds. Not listed (left out): tobacconists ("expendeduria"),
# charging points ("punto_recarga_electrica"), postcodes, roads by kilometre point.
_KINDS: dict[str, PlaceKind] = {
    "portal": "address",
    "callejero": "street",
    "toponimo": "place",
    "ngbe": "place",  # geographic names: parks, neighbourhoods, hills
    "poblacion": "area",
    "municipio": "area",
}
# Stops and stations: the stop search has them, with their lines.
_TRANSIT = re.compile(
    r"^(estaci[oó]n\b(?! de servicio)|parada|apeadero|intercambiador|cambiador|metro ligero"
    r"|est\. metro)",
    re.IGNORECASE,
)
# Businesses from the company register: "Audio Seleccion, S.L. [calle Mayor 52]". Kept, but
# after the other answers.
_BUSINESS = re.compile(r"\[|\bS\.\s?[AL]\.|\bS\.[AL]\.U\.", re.IGNORECASE)
_BRACKET = re.compile(r"^(.*?)\s*\[([^\]]*)\]\s*$")
# Words kept in lower case when an all-capitals name is put in normal case.
_SMALL = {"de", "del", "la", "las", "los", "el", "y", "e", "a", "en", "al"}


class PlaceResult(BaseModel):
    id: str
    name: str
    #: Where it is: "28013 Madrid", "Parla".
    detail: str | None
    kind: PlaceKind
    lat: float
    lon: float
    #: A business from the company register (listed after the other answers).
    business: bool = False


_RESULTS = TypeAdapter(list[PlaceResult])


def nice_case(s: str) -> str:
    """'CALLE MAYOR DE LA VILLA 5' -> 'Calle Mayor de la Villa 5'. Mixed-case text is kept."""
    if s != s.upper():
        return s
    words = s.lower().split(" ")
    out = [w if (i > 0 and w in _SMALL) else w[:1].upper() + w[1:] for i, w in enumerate(words)]
    # "S.A." and Roman numerals stay as they were.
    return " ".join(
        o.upper() if re.fullmatch(r"([a-z]\.)+|[ivxl]+", o.lower()) and len(o) > 1 else o
        for o in out
    )


def _strip_town(address: str, town: str | None) -> str:
    """CartoCiudad appends the town: 'CALLE MAYOR 5, Madrid', 'IKEA ..., Carretera X (Alcorcón)'."""
    if town:
        for suffix in (f", {town}", f" ({town})"):
            if address.endswith(suffix):
                return address[: -len(suffix)]
    return address


def _in_area(lat: float, lon: float) -> bool:
    return BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]


def to_place(c: dict[str, Any]) -> PlaceResult | None:
    """One CartoCiudad candidate as a place, or None when left out. Streets get their point
    later (`street_point`), so they come with lat = lon = 0."""
    kind = _KINDS.get(c.get("type") or "")
    address = (c.get("address") or "").strip()
    if kind is None or not address:
        return None
    town = (c.get("muni") or "").strip() or None
    name = nice_case(_strip_town(address, town)).strip()
    if not name or _TRANSIT.match(name):
        return None
    business = kind == "place" and bool(_BUSINESS.search(name))
    where: str | None = None
    if m := _BRACKET.match(name):  # "Shop [CALLE REAL, 125]" -> "Shop", at "Calle Real, 125"
        name, where = m.group(1).strip(), nice_case(m.group(2).strip()) or None
    if not name:
        return None
    lat, lon = float(c.get("lat") or 0), float(c.get("lng") or 0)
    if kind != "street" and not _in_area(lat, lon):
        return None
    if kind == "area":
        detail = c.get("province") if name != c.get("province") else None
    elif kind == "address":
        postcode = (c.get("postalCode") or "").split(" ")[0]
        detail = " ".join(p for p in (postcode, town) if p) or None
    else:
        detail = " · ".join(p for p in (where, town) if p) or None
    if detail and detail == name:
        detail = None
    return PlaceResult(
        id=f"cc:{c.get('type')}:{c.get('id')}",
        name=name,
        detail=detail,
        kind=kind,
        lat=round(lat, 6),
        lon=round(lon, 6),
        business=business,
    )


def _metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    dy = (a[0] - b[0]) * 111_320
    dx = (a[1] - b[1]) * 111_320 * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy)


def rank(places: list[PlaceResult], near: tuple[float, float]) -> list[PlaceResult]:
    """CartoCiudad's order, except that places with the same name (Calle Mayor 5 in many
    towns) are listed nearest first, where the first of them was, and businesses come last.
    Streets have no point yet: Madrid city's counts as nearest, the others as far."""

    def distance(p: PlaceResult) -> float:
        if p.lat:
            return _metres((p.lat, p.lon), near)
        return 0 if p.detail == "Madrid" else 1e9

    first: dict[str, int] = {}
    for i, p in enumerate(places):
        first.setdefault(p.name.lower(), i)
    return sorted(places, key=lambda p: (p.business, first[p.name.lower()], distance(p)))


def street_point(geom: str | None) -> tuple[float, float] | None:
    """A point on a street from its WKT (MULTI)LINESTRING: the vertex nearest the middle."""
    nums = re.findall(r"(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)", geom or "")
    pts = [(float(y), float(x)) for x, y in nums]
    if not pts:
        return None
    mid = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    lat, lon = min(pts, key=lambda p: _metres(p, mid))
    return (lat, lon) if _in_area(lat, lon) else None


class GeocoderUnavailable(Exception):  # noqa: N818 - reads better at the call site
    pass


@dataclass
class Geocoder:
    http: httpx.AsyncClient
    base_url: str
    timeout_s: float

    async def _get(self, path: str, params: dict[str, str | int]) -> Any:
        if not self.base_url:
            raise GeocoderUnavailable("not configured")
        try:
            resp = await self.http.get(
                f"{self.base_url.rstrip('/')}/{path}",
                params=params,
                timeout=self.timeout_s,
                headers={"User-Agent": f"MadridGo/{__version__} (transit planner)"},
            )
        except httpx.HTTPError as exc:
            log.warning("Geocoder request failed: %s", type(exc).__name__)
            raise GeocoderUnavailable(type(exc).__name__) from exc
        if resp.status_code != 200:
            log.warning("Geocoder answered HTTP %s", resp.status_code)
            raise GeocoderUnavailable(f"HTTP {resp.status_code}")
        try:
            return resp.json()
        except ValueError as exc:
            raise GeocoderUnavailable("not JSON") from exc

    async def candidates(self, q: str, area: dict[str, str]) -> list[dict[str, Any]]:
        body = await self._get("candidates", {"q": q, "limit": FETCH, **area})
        return list(body) if isinstance(body, list) else []

    async def street(self, native_id: str) -> str | None:
        """The street's shape (WKT), or None."""
        try:
            body = await self._get("find", {"id": native_id, "type": "callejero"})
        except GeocoderUnavailable:
            return None
        return body.get("geom") if isinstance(body, dict) else None


async def search(geocoder: Geocoder, q: str, near: tuple[float, float]) -> list[PlaceResult]:
    # The whole region, and Madrid city on its own: in the region-wide answer the capital's
    # "Calle Mayor 5" can be missing behind the same address in 20 other towns.
    answers: tuple[list[dict[str, Any]] | BaseException, ...] = await asyncio.gather(
        geocoder.candidates(q, {"provincia_filter": "Madrid"}),
        geocoder.candidates(q, {"municipio_filter": "Madrid"}),
        return_exceptions=True,
    )
    lists = [a for a in answers if isinstance(a, list)]
    if not lists:  # both failed: say so; one is enough to answer
        error = next(a for a in answers if isinstance(a, BaseException))
        if isinstance(error, GeocoderUnavailable):
            raise error
        raise GeocoderUnavailable("failed") from error
    raw = [c for a in lists for c in a]
    places: list[PlaceResult] = []
    natives: dict[str, str] = {}
    seen: set[tuple[str, str | None]] = set()
    for c in raw:
        p = to_place(c)
        if p is None or p.id in natives or (p.name.lower(), p.detail) in seen:
            continue
        seen.add((p.name.lower(), p.detail))
        places.append(p)
        natives[p.id] = str(c.get("id"))
    # Streets get their point only now, after ranking: one request each, for the first few.
    ranked = rank(places, near)[: LIMIT + MAX_STREETS]
    streets = [p for p in ranked if p.kind == "street"][:MAX_STREETS]
    geoms = await asyncio.gather(*(geocoder.street(natives[p.id]) for p in streets))
    located = {p.id: street_point(g) for p, g in zip(streets, geoms, strict=True)}
    out: list[PlaceResult] = []
    for p in ranked:
        if p.kind == "street":
            point = located.get(p.id)
            if point is None:
                continue
            p = p.model_copy(update={"lat": round(point[0], 6), "lon": round(point[1], 6)})
        out.append(p)
    return out[:LIMIT]


_geocoder: Geocoder | None = None


def get_geocoder() -> Geocoder:
    global _geocoder
    if _geocoder is None:
        s = get_settings()
        _geocoder = Geocoder(httpx.AsyncClient(), s.places_url, s.places_timeout_s)
    return _geocoder


async def close_geocoder() -> None:
    global _geocoder
    if _geocoder is not None:
        await _geocoder.http.aclose()
        _geocoder = None


def cache_key(q: str, near: tuple[float, float]) -> str:
    raw = f"{' '.join(q.lower().split())}|{near[0]:.2f},{near[1]:.2f}"
    return "places:cartociudad:" + hashlib.sha256(raw.encode()).hexdigest()[:32]


@router.get("/places/search", response_model=list[PlaceResult])
async def search_places(
    geocoder: Annotated[Geocoder, Depends(get_geocoder)],
    kv: Annotated[KV, Depends(get_kv)],
    q: Annotated[str, Query(min_length=3, max_length=100, description="Address or place")],
    lat: Annotated[
        float | None, Query(ge=39.8, le=41.2, description="List equal names nearest this first")
    ] = None,
    lon: Annotated[float | None, Query(ge=-4.6, le=-3.0)] = None,
) -> list[PlaceResult]:
    """Addresses, streets and places in the Comunidad de Madrid (CartoCiudad, IGN), best match
    first. Public transport stops are not included: use `/stops/search` for them."""
    q = " ".join(q.split())
    if len(q) < 3:
        raise HTTPException(status_code=422, detail="Type at least 3 letters")
    near = (lat, lon) if lat is not None and lon is not None else CENTRE
    key = cache_key(q, near)
    try:
        cached = await kv.get(key)
    except Exception:  # Redis down: search anyway
        cached = None
    if cached is not None:
        return _RESULTS.validate_json(cached)
    try:
        places = await search(geocoder, q, near)
    except GeocoderUnavailable as exc:
        raise HTTPException(status_code=503, detail=tr("places.unavailable")) from exc
    try:
        await kv.set(key, _RESULTS.dump_json(places), CACHE_TTL_S)
    except Exception:
        log.warning("Could not cache a place search")
    return places
