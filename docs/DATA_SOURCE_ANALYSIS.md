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
| 6 | Renfe static GTFS (data.renfe.com) | Static GTFS | Cercanías | None | data.renfe.com licence page | No | Yes |
| 7 | CRTM widget API (crtm.es/widgets/api) | Undocumented JSON | All modes | None | **None covers it** | Partial, unlabelled | **No**, pending CRTM permission |
| 8 | CRTM feed to Google Maps | Unknown (probably GTFS-RT) | Urban and interurban buses | Unknown | Unknown | Yes | **Unknown**: must request |
| 9 | Metro de Madrid real-time | None public | Metro | – | – | Not public | **No** public source found |
| 10 | NAP (nap.transportes.gob.es) | Static GTFS mirror | Various | Registration | NAP licence | Not for Madrid, as far as found | Optional mirror |
| 11 | OpenStreetMap (Geofabrik extract) | OSM PBF | Street network for walking | None | ODbL | No | Yes, attribution required |

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
| Cercanías | `1a25440bf66f499bae2657ec7fb40144` | 3.8 MB | – | 2026-10-30 → **2026-11-28** | 38 | 95 | 35 969 | Renfe-published (agency `1071VC`); IDs match Renfe GTFS-RT. Only one month of validity |
| Interurban | `885399f83408473c8d815e40c5e702b7` | 76 MB | 20261027 | 2026-10-27 → 2027-11-28 | 354 | 8 408 | 58 470 | Description says **"(Datos parciales)"** |
| Urban (municipal) | `357e63c2904f43aeb5d8a267a64346d8` | 9.8 MB | 20261027 | 2026-10-27 → 2027-11-28 | 117 | 8 408 | 18 345 | Shares stops file with interurban |
| EMT | `868df0e58fca47e79b942902dffd7da0` | 21 MB | – | 2026-10-30 → 2026-12-31 | 238 | 4 935 | 86 843 | **Fully frequency-based** (86 843 frequency rows, no `exact_times`) |

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
  - Vehicle positions include `currentStatus`, `stopId`, a vehicle `timestamp` (true observation time), and labels such as `C1-23547-PLATF.(3)`, which encode the **platform**.
- Trip IDs in RT (for example `3012L23547C1`) must be matched to the static GTFS. CRTM's Cercanías GTFS uses Renfe route IDs (`10T0001C1`) and stop IDs (`10000`); trip-ID matching **verified in Phase 2 (2026-11-09)**: all 78 Madrid trip updates (IDs `10…`) matched static trip IDs exactly, so no mapping table is needed. Unmatched IDs belong to other Renfe networks. [V]
- Public map: https://tiempo-real.renfe.com (website, not an API). [V via secondary]

---

## 5. Metro de Madrid and Metro Ligero

- Static: CRTM GTFS (Metro expired, see §2.2; ML valid). [V]
- Real-time: **no public API or GTFS-RT feed found.** [V: absence across searches] A 2023 article describes a Community of Madrid pilot with real-time information on line 5, updated every 15 s ([elEconomista](https://www.eleconomista.es/tecnologia/noticias/12459178/09/23/asi-puedes-saber-si-el-metro-de-madrid-va-lleno-o-no-con-la-app-de-la-comunidad-de-madrid.html)). CRTM's MuévetexMadrid pilot app (Aug 2024) shows real-time intervals and positions for Metro, urban and interurban buses and Cercanías ([CRTM](https://www.crtm.es/comunicacion/sala-de-prensa/noticias/noticias/19082024-la-comunidad-de-madrid-lanza-en-pruebas-una-app-planificadora-de-viajes-con-todas-las-opciones-de-transportes-publico-en-tiempo-real/?lang=es)). This proves the data exists internally, but **no third-party access** was announced.
- The CRTM widget returns second-precision Metro times (see CRTM_WIDGET_ANALYSIS.md §5.4); not authorized.

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

## 9. Third-party aggregators (not used)

Google Maps, Moovit and others show Madrid real-time data, but their terms do not permit reuse as a data source for another app. They are useful only as **comparison baselines** for prediction-quality spot checks, done manually [I].

## 10. Actions from this analysis
1. Register a MobilityLabs account (project owner) and confirm auth flow, quotas and response fields.
2. Send the CRTM access request (template in CRTM_WIDGET_ANALYSIS.md §8), and ask about the expired Metro GTFS.
3. Confirm Renfe licence for TripUpdates/VehiclePositions datasets on data.renfe.com.
4. ~~Phase 2: verify Renfe RT trip_id ↔ static trip_id matching.~~ Done: IDs match exactly (§4).
