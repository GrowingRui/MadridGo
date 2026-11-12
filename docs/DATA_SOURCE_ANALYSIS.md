# Data Source Analysis

**Status:** Phase 0 research. Investigation date: **2026-11-09**.
Legend: **[V]** verified (official source or our own inspection), **[I]** inference, **[U]** unresolved.

---

## 1. Summary table

| # | Source | Type | Modes | Auth | Licence | Real-time? | Usable by MadridGo? |
|---|---|---|---|---|---|---|---|
| 1 | CRTM Open Data (datos.crtm.es) | Static GTFS (6 feeds) | Metro, ML, Cercanías, interurban, urban, EMT | None | CRTM "Licencia de datos abiertos y estáticos" | No | **Yes**, with attribution. See quality caveats in §2. |
| 2 | EMT MobilityLabs / OpenAPI | REST API (JSON) | EMT buses | Registration plus token | EMT terms; dataset listed as ODbL | **Yes**, arrivals | **Yes**, after registration |
| 3 | EMT GTFS (datos.emtmadrid.es) | Static GTFS | EMT | None | EMT terms | No | Yes |
| 4 | EMT incidents RSS | RSS | EMT | None | EMT terms | Near-real-time alerts | Yes |
| 5 | Renfe GTFS-RT (gtfsrt.renfe.com) | GTFS-RT protobuf and JSON | Cercanías (all networks, including Madrid) | None | CC BY 4.0 (verified for alerts) | **Yes**: TripUpdates, VehiclePositions, Alerts | **Yes** |
| 6 | Renfe static GTFS (data.renfe.com, [horarios-cercanias](https://data.renfe.com/dataset/horarios-cercanias)) | Static GTFS | Cercanías (all of Spain's networks) | None | CC BY 4.0 [V] | No | **Yes, used for Madrid Cercanías since 2026-11-12** |
| 7 | CRTM widget API (crtm.es/widgets/api) | Undocumented JSON | All modes | None | **None covers it** | Partial, unlabelled | **No**, pending CRTM permission |
| 8 | CRTM feed to Google Maps | Unknown (probably GTFS-RT) | Urban and interurban buses | Unknown | Unknown | Yes | **Unknown**: must request |
| 9 | Metro de Madrid real-time | None public | Metro | – | – | Not public | **No** public source found |
| 10 | NAP (nap.transportes.gob.es) | Static GTFS mirror | Various | Registration | NAP licence | Not for Madrid, as far as found | Optional mirror |
| 11 | OpenStreetMap (Geofabrik extract) | OSM PBF | Street network for walking | None | ODbL | No | Yes, attribution required |
| 12 | CartoCiudad geocoder (IGN, cartociudad.es) | REST API (JSON) | Addresses, streets and places (search) | None | CC BY 4.0 [I] | No | **Yes, used for address and place search since 2026-11-12** (§8.1) |

---

## 2. CRTM Open Data — static GTFS

Portal: https://datos.crtm.es/ (ArcGIS Hub; also https://data-crtm.opendata.arcgis.com/). Downloads are served as ArcGIS items at `https://www.arcgis.com/sharing/rest/content/items/{id}/data`. [V]

Licence for every item inspected: **https://www.crtm.es/licencia-de-uso** [V]. Key conditions:
- Commercial and non-commercial reuse allowed.
- Must cite CRTM as source; digital platforms must show **"Powered by CRTM"** with a link to crtm.es.
- Must keep information up to date; must not alter update-date or licence metadata.
- Must not imply endorsement by CRTM.
- Data provided "as is", with no guarantee of correctness or continuity.
- CRTM may block abusive reusers.
- **Covers "datos calificados como estáticos" only.**

### 2.1 Feed inventory (downloaded and inspected 2026-11-09) [V]

| Feed | ArcGIS id | Size | feed_version | Calendar validity | Routes | Stops | Trips | Notes |
|---|---|---|---|---|---|---|---|---|
| Metro | `5c7f2951962540d69ffe8f640d94c246` | 1.5 MB | 20250527 | **2025-05-27 → 2026-05-27 (EXPIRED)** | 13 | 1 050 | 120 | Frequency-based (790 `frequencies.txt` rows, `exact_times` empty) |
| Metro Ligero | `aaed26cc0ff64b0c947ac0bc3e033196` | 0.4 MB | 20261028 | 2026-10-28 → 2027-10-28 | 4 | 96 | 2 720 | Explicit stop_times |
| Cercanías | `1a25440bf66f499bae2657ec7fb40144` | 3.8 MB | – | 2026-10-30 → **2026-11-28** | 38 | 95 | 35 969 | Renfe-published (agency `1071VC`); IDs match Renfe GTFS-RT. Only one month of validity. **No longer used since 2026-11-12:** MadridGo reads Renfe's own feed (source 6), see below |
| Interurban | `885399f83408473c8d815e40c5e702b7` | 76 MB | 20261027 | 2026-10-27 → 2027-11-28 | 354 | 8 408 | 58 470 | Description says **"(Datos parciales)"** |
| Urban (municipal) | `357e63c2904f43aeb5d8a267a64346d8` | 9.8 MB | 20261027 | 2026-10-27 → 2027-11-28 | 117 | 8 408 | 18 345 | Shares stops file with interurban |
| EMT | `868df0e58fca47e79b942902dffd7da0` | 21 MB | – | 2026-10-30 → 2026-12-31 | 238 | 4 935 | 86 843 | **Fully frequency-based** (86 843 frequency rows, no `exact_times`) |

**Cercanías source change (2026-11-12).** CRTM's Cercanías copy was still the 2026-10-30 → 2026-11-28 file on 2026-11-12, while Renfe had published a new national file that day (`https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip`, 15.8 MB, 276 routes, CC BY 4.0). CRTM's file is that file cut down to Madrid: same agency `1071VC`, stop IDs, names, positions and route IDs; 20 086 trip IDs in common with the old file. MadridGo now downloads Renfe's file and keeps routes whose `route_id` starts with `10` (Madrid network) and the trips, stops, calendars and shapes they use (`app/ingest/subset.py`; `route_prefix` in `sources.py`); Renfe pads headers and values with spaces, which the subset step trims. Result: 41 routes (3 new variants: `10T0035C5`, `10T0037C2`, `10T0097C8b`), 95 stops (new: `70005` Vallecas), 36 600 trips, calendar 2026-11-12 → **2026-12-11**; validator 0 errors. All 104–109 live Madrid trip updates matched its trip IDs. Renfe's `routes.txt` has no `agency_id`, so the subset keeps every agency row. OTP logs "trip times within block are not increasing" for some C2/C8 `block_id`s, as with the old file (no effect on routing). **Shapes:** Renfe's 24 shapes come in pairs (`10_C4b` and `10_C4b_INV`, one the other reversed), but about half of the trip patterns point to the pair's other direction, and some shapes leave out a branch (stations 2–23 km away). OTP then draws those trips straight. The ingest repairs this (`app/ingest/shapes.py`): per trip pattern it keeps the shape or uses it reversed, so that every station is within 150 m of the shape and in order; when neither fits it stitches a shape hop by hop from pieces of the other shapes (only San Fernando de Henares ↔ Fuente de la Mora is on no shape and stays straight); 2026-11-12 file: 38 kept, 48 reversed, 7 stitched of 93 patterns. `route_long_name` pads the first terminus to 40 characters ("Colmenar Viejo⎵⎵⎵…-Parla"); the subset step makes it "Colmenar Viejo - Parla". 130 trips in Renfe's Madrid routes have no stop times (OTP ignores them). **Stop positions:** compared with CRTM's copy, 94 of the 95 Madrid stations are in exactly the same place; `70005` Vallecas is 140 m east of the station (40.382364, -3.623042). CRTM's copy (stop `70001`, 40.3819607, -3.6245835) and OpenStreetMap (station node 5320204129) agree with each other, so the ingest moves it there (`stop_positions` in `sources.py`, applied by the subset step; found 2026-11-12 from a user report).

### 2.2 Quality findings that matter for reliability
1. **The Metro GTFS has expired.** Its calendar ended 2026-05-27. A routing engine fed this file will find **no Metro service today**. Metro is the backbone of Madrid's network, so this is a **blocking issue for journey planning**. [V] Options: (a) check whether a newer Metro feed exists elsewhere, such as the NAP or Mobility Database mirrors [U]; (b) contact CRTM; (c) as a labelled last resort, extend the calendar locally and mark Metro times as "frequency estimate, source calendar expired". This would need explicit product approval.
2. **Metro and EMT schedules are frequency-based**, for example "every 15 min between 07:00 and 07:59:59". They do not contain exact departure times. Any "scheduled time" MadridGo shows for these modes is **an estimate from a headway**, and the UI must say so ("every ~12 min").
3. **Cercanías validity is short** (about one month). The ingestion pipeline must refresh it at least weekly and alarm on expiry.
4. **Interurban data is marked partial.** Coverage gaps must be expected; unresolved which lines are missing [U].
5. **No `transfers.txt`** in CRTM feeds (except 2 rows in Cercanías). Transfer times must come from the routing engine's walking model (OSM) plus configured slack.
6. Text encoding: CRTM files are UTF-8; console artefacts seen during inspection were Windows display issues, not file defects. [I]

---

## 3. EMT Madrid — MobilityLabs

- Portal: https://mobilitylabs.emtmadrid.es/ ; docs: https://apidocs.emtmadrid.es/ (JS app, Swagger) [V]
- Registration required: user account, then app registration; the account must be activated by email. [V]
- Arrival endpoint (from the official dataset page, https://datos.emtmadrid.es/es/dataset/tiempo-real-para-autobuses-de-emt/resource/ceb1c3a2-4a58-450b-8672-84e792016147): [V]
  - `https://openapi.emtmadrid.es/v3/transport/busemtmad/stops/<stopId>/arrives/all/`
  - Swagger operation `arrives_v2_transport_busemtmad_stops__stopId__arrives__lineArrive___post` (v2 `POST .../stops/{stopId}/arrives/{lineArrive}/`)
- Authentication (verified in the official apidoc data, https://apidocs.emtmadrid.es/api_data.js, 2026-11-09): [V]
  - `GET /v?/mobilitylabs/user/login/` with **either** headers `email` + `password` (personal account) **or** `X-ClientId` + `passKey` (registered application). `X-ApiKey` is deprecated.
  - The login returns an access token; data endpoints such as `POST v2/transport/busemtmad/stops/<stopId>/arrives/<lineArrive>/` take it in the `accessToken` header.
  - **MadridGo uses `X-ClientId` + `passKey`** (application credentials, held only in the backend `.env`), never the owner's personal password.
- Dataset licence label: **ODbL** (datos.emtmadrid.es resource page). [V]
- Terms of use (https://mobilitylabs.emtmadrid.es/sip/terms-of-use): [V]
  - Commercial and non-commercial reuse allowed, including redistribution and derivative works.
  - Must not manipulate or falsify information, or damage EMT's public image.
  - Attribution **"Powered by EMT de Madrid"**, preferably linking to EMT.
  - Dynamic data requires a personal unique identifier; EMT monitors access and may block abusive use; identifiers may expire.
  - No numeric rate limits published in the terms [U: limits may exist in the API itself].
  - No guarantee of continuity or accuracy; one-year term that renews automatically; on termination, received data must be deleted.
- Other EMT resources: GTFS `gtfs_emt.zip` (last-modified 2026-11-06, 21 MB) [V]; incidents RSS `http://servicios.emtmadrid.es:8080/rss/emtrss.xml` [V, listed on portal]; examples at https://gitlab.com/mobilitylabsmadrid [V].
- Madrid City open-data portal also catalogues the EMT real-time dataset: https://datos.madrid.es/dataset/900029-0-emt-autobus-tiempo-real [V].

**Phase 3 findings (2026-11-09):** login with the registered application's `X-ClientId` + `passKey` returns HTTP 403 `{"code": "84"}` on v1 and v2 (code 84 is not documented) [V]. Cause: EMT has not yet approved the application (project owner, 2026-11-09) [V]. The arrivals response has no observation timestamp, only the server's answer time (`datetime`, local time without offset) [V, apidoc]; MadridGo therefore measures EMT ages from retrieval.

**Approval (2026-11-12):** EMT approved the application. Login with `X-ClientId` + `passKey` returns code 00 on v1 and v2, with a quota of 250,000 calls a day, a token valid about 24 h, and the licence note "Please mention EMT Madrid MobilityLabs as data source" [V]. A real arrivals response (stop 72, 16 buses) has exactly the documented fields [V]: `line`, `destination`, `estimateArrive` (s), `bus` (vehicle id), `DistanceBus` (m), `geometry` (the bus's GPS point), `isHead`, `deviation`, `positionTypeBus`. There is no flag separating predictions from timetable times and no observation timestamp, so ages stay measured from retrieval. Login with empty credentials (for example when `.env` is not loaded) returns HTTP 405 with the same code 84. Incidents RSS: 184 items, lines as `<category>`, validity in `rssAfectaDesde`/`rssAfectaHasta` (Madrid local time) [V].

**Unknown [U]:** update cadence of predictions; whether responses carry an observation timestamp or flag estimates vs. schedule; vehicle position availability; quotas. These must be measured in Phase 3 with a registered key.

---

## 4. Renfe Cercanías — GTFS Realtime

Feeds (all returned HTTP 200, no authentication, 2026-11-09): [V]

| Feed | URL | Observed size |
|---|---|---|
| Alerts | https://gtfsrt.renfe.com/alerts.pb (also `.json`) | 44 KB |
| Trip updates | https://gtfsrt.renfe.com/trip_updates.pb (also `.json`) | 30 KB |
| Vehicle positions | https://gtfsrt.renfe.com/vehicle_positions.pb (also `.json`) | 35 KB |
| Long-distance trip updates | https://gtfsrt.renfe.com/trip_updates_LD.pb | 14 KB |

- Licence: alerts dataset page states **Creative Commons Attribution 4.0** and "Esta información se actualiza cada 20 segundos" (https://data.renfe.com/dataset/incidencias-avisos). [V] Licence of the trip-update and vehicle-position datasets was not individually confirmed [U]; the Mobility Database lists them as related Renfe feeds ([mdb-2833](https://mobilitydatabase.org/feeds/gtfs_rt/mdb-2833)).
- Observed content (JSON variant): [V]
  - Header timestamp only **16 s old** at fetch time.
  - Network-wide: 419 trip updates (399 `SCHEDULED`, 20 `CANCELED`), 406 vehicle positions.
  - **Madrid network** (trip IDs prefixed `10`, coordinates within lat 40.03–40.64, lon −4.25 to −3.18): **75 vehicles** on C1, C2, C3, C4a, C4b, C5, C7, C8a, C8b, C10; 81 trip updates, 54 with positive delay.
  - Most trip updates carry **one** `stopTimeUpdate` plus a trip-level `delay`, so OTP must propagate the delay to later stops. Max observed delay was 5 760 s, an outlier to investigate.
  - Vehicle positions include `currentStatus`, `stopId`, a vehicle `timestamp`, and labels such as `C1-23547-PLATF.(3)`, which encode the **platform**.
  - **Correction and field meanings (checked 2026-11-10 against GPS, the timetable and 3 min of live polls; details in `services/api/app/trips.py`):** the vehicle `timestamp` equals the feed header time, so it is not an observation time per vehicle. `stopId` is the station the train is at or has just left (the trip update's stop is always the next one), whatever `currentStatus` says. Most positions are the station's own coordinates, kept until the train reaches the next station; positions sometimes step back one station; around midday most vehicles in the feed are trains waiting at their origin. On 2026-11-10 (SEMAF drivers' strike) only ~23 Madrid vehicles were in the feed, 4 of them mid-journey.
- Trip IDs in RT (for example `3012L23547C1`) must be matched to the static GTFS. CRTM's Cercanías GTFS uses Renfe route IDs (`10T0001C1`) and stop IDs (`10000`); trip-ID matching **verified in Phase 2 (2026-11-09)**: all 78 Madrid trip updates (IDs `10…`) matched static trip IDs exactly, so no mapping table is needed. Unmatched IDs belong to other Renfe networks. [V]
- Public map: https://tiempo-real.renfe.com (website, not an API). [V via secondary]

---

## 5. Metro de Madrid and Metro Ligero

- Static: CRTM GTFS (Metro expired, see §2.2; ML valid). [V]
- Real-time: **no public API or GTFS-RT feed found.** [V: absence across searches] A 2023 article describes a Community of Madrid pilot with real-time information on line 5, updated every 15 s ([elEconomista](https://www.eleconomista.es/tecnologia/noticias/12459178/09/23/asi-puedes-saber-si-el-metro-de-madrid-va-lleno-o-no-con-la-app-de-la-comunidad-de-madrid.html)). CRTM's MuévetexMadrid pilot app (Aug 2024) shows real-time intervals and positions for Metro, urban and interurban buses and Cercanías ([CRTM](https://www.crtm.es/comunicacion/sala-de-prensa/noticias/noticias/19082024-la-comunidad-de-madrid-lanza-en-pruebas-una-app-planificadora-de-viajes-con-todas-las-opciones-de-transportes-publico-en-tiempo-real/?lang=es)). This proves the data exists internally, but **no third-party access** was announced.
- The CRTM widget returns second-precision Metro times (see CRTM_WIDGET_ANALYSIS.md §5.4); not authorized.
- CRTM open data portal, tag `metro` ([datos.crtm.es](https://datos.crtm.es/search?tags=metro)), checked 2026-11-12: 3 items, none real-time (a search for "tiempo real", "realtime" and "GTFS-RT" across all 64 items finds nothing). "GTFS Red de Metro" is the item MadridGo already downloads (`5c7f…246`), last modified 2025-05-30, so still the expired timetable. The two ArcGIS Feature Services, "Elementos de la Red de Metro" (`M4_Red`: stations, entrances, halls, platforms, track sections, stops per route) and "Líneas de la Red de Metro" (`M4_Lineas`), are static geometry: possibly useful later for station entrances and line shapes on the map. [V]

## 6. Interurban and municipal urban buses (non-EMT)

- Static: CRTM GTFS (interurban marked partial; urban valid). [V]
- Real-time: exists (CRTM widget; Google Maps integration since April 2026), but **no authorized third-party channel found**. [V] See CRTM_WIDGET_ANALYSIS.md.
- This includes the example stop **8_16825** (Parla; lines 469 and urban 3).

## 7. National Access Point (NAP)

- https://nap.transportes.gob.es hosts static GTFS for some CRTM feeds (Transitland references NAP file 1361 for interurban and 1134 for Metro). [V via Transitland/search]
- No Madrid GTFS-RT was found on the NAP. [V: absence] An industry article states Spain's NAP does not mandate a single real-time format ([PySAE](https://www.pysae.com/es/content/article/gtfs-rt-siri-netex-espana-formato-datos-tiempo-real)).
- Requires registration for API downloads [U: confirm in Phase 2].

## 8. OpenStreetMap and map tiles

- OSM data: ODbL, attribution "© OpenStreetMap contributors" required; free for commercial use ([OSMF](https://osmfoundation.org/wiki/FAQ)). [V]
- Walking network for OTP: a Geofabrik Comunidad de Madrid extract (`.osm.pbf`) [I: standard practice; size to measure].
- Map tiles: OpenFreeMap public instance has no API key, no registration and no request limits ([openfreemap.org](https://openfreemap.org)) [V]; the OSMF vector tile service has a usage policy ([policy](https://operations.osmfoundation.org/policies/vector/)) [V]. Self-hosting PMTiles (Protomaps) is the long-term zero-dependency option [I].

### 8.1 Address and place search (geocoding), chosen 2026-11-12

The planner searches addresses ("Calle Mayor 5"), streets and named places ("Hospital 12 de Octubre") through `GET /places/search` (`services/api/app/places.py`), which calls **CartoCiudad** (Instituto Geográfico Nacional): `candidates?q=…&provincia_filter=Madrid` and, in parallel, `municipio_filter=Madrid`; streets get a point from `find?id=…&type=callejero` (their shape). No key or registration. Licence: IGN/CNIG data under CC BY 4.0 [I: to confirm on the CNIG licence page]; credited as "CartoCiudad © Instituto Geográfico Nacional" in About and "Addresses: CartoCiudad (IGN)" under the results.

Compared on 2026-11-12 [V, by test queries]:
- **CartoCiudad**: answers in 0.2-1 s; official address points down to the building number, plus named places (hospitals, museums, stadiums, shops). No ranking by distance: "Calle Mayor 5" lists the street in every town that has one, and Madrid city's could be missing from the first 20 region-wide answers, so we also ask for Madrid city and list equal names nearest the centre first. Some names come in capitals and without accents ("Calle Alcala 100"); entries from the company register ("Óptica X, S.L. [calle Mayor 52]") are listed last. Typing the town finds the right one ("calle real 10 parla").
- **Photon** (komoot, OpenStreetMap): best ranking (prefers results near a point, made for search-as-you-type), but the public server took 35-40 s per query that day (fair-use service, no guarantee). Self-hosting is possible later (Spain extract about 2 GB compressed, needs Java and several GB of disk), the way OTP runs today; the backend only needs a new `Geocoder` behind the same endpoint.
- **Nominatim** (OpenStreetMap): its public server's policy allows at most 1 request a second and forbids search-as-you-type; not suitable without self-hosting.

Answers are cached for 7 days in Redis; the app asks only from 3 letters, after a pause in typing. If CartoCiudad is down the endpoint answers 503 and the app still lists stops, with a line saying address search is unavailable.

## 9. Third-party aggregators (not used)

Google Maps, Moovit and others show Madrid real-time data, but their terms do not permit reuse as a data source for another app. They are useful only as **comparison baselines** for prediction-quality spot checks, done manually [I].

## 10. Actions from this analysis
1. Register a MobilityLabs account (project owner) and confirm auth flow, quotas and response fields.
2. Send the CRTM access request (template in CRTM_WIDGET_ANALYSIS.md §8), and ask about the expired Metro GTFS.
3. Confirm Renfe licence for TripUpdates/VehiclePositions datasets on data.renfe.com.
4. ~~Phase 2: verify Renfe RT trip_id ↔ static trip_id matching.~~ Done: IDs match exactly (§4).
