# CRTM Widget Analysis

**Status:** Phase 0 research. Investigation date: **2026-11-09**.
**Subject:** https://www.crtm.es/widgets/#/stop/8_16825/map

Legend used throughout:
- **[V]** Verified: observed directly (our own HTTP inspection on 2026-11-09) or stated in an official source (URL given).
- **[I]** Inference: a reasoned conclusion from verified observations that is not explicitly confirmed by CRTM.
- **[U]** Unresolved: cannot be verified without CRTM's cooperation.

---

## 1. Executive summary

| Question | Answer |
|---|---|
| What is the widget? | An AngularJS single-page application served from `https://www.crtm.es/widgets/` that renders stop, line, map and office information for all CRTM modes. [V] |
| Where does its data come from? | A JSON backend at `https://www.crtm.es/widgets/api/*.php` (relative path `/widgets/api/` in the production config). [V] |
| Is it real-time? | **Partly.** Responses mix times with second-level precision (consistent with real-time predictions) and round-minute times (consistent with timetable). **No field explicitly says which is which.** [V for the data, I for interpretation] |
| Vehicle positions? | Yes, for line maps: `GetLineLocation.php`, polled every **15 s**. `codVehicle` is empty in stop-time responses for the stop we sampled. [V] |
| Officially documented API? | **No.** No documentation, developer portal, terms or API key system was found for `/widgets/api/`. [V: absence after search of crtm.es, datos.crtm.es and web search] |
| Is third-party use authorized? | **Not established.** CRTM's open-data licence ("Licencia de datos abiertos y estáticos", https://www.crtm.es/licencia-de-uso) covers **static** data downloadable from the public part of the website. It does not mention real-time data or APIs. [V] |
| Authentication / rate limits? | No authentication, no API key, `Cache-Control: no-store`. No rate limits are published. CRTM's licence states it may block reusers whose usage it judges abusive. [V] |
| Can MadridGo build on it? | **Not without written permission from CRTM.** It is technically reachable, but being reachable is not authorization. MadridGo must not ship a production dependency on it. |

**Bottom line:** MadridGo can technically reproduce the widget's experience. The data that powers it (interurban and municipal-urban bus predictions, Metro predictions) currently has **no authorized third-party access path that we could find**. Obtaining that authorization is the **single most important non-technical task** in the project.

---

## 2. Method

1. Fetched `https://www.crtm.es/widgets/` (HTML, 23.5 KB) and the application bundle `https://www.crtm.es/widgets/app/main.min.js` (239.7 KB). Both are public static assets served to every visitor.
2. Read the bundle source to identify routes, services, endpoints and refresh logic. The source is not obfuscated.
3. Made **single requests** to the same endpoints a browser calls when a person opens the example stop page (`GetStopsInformation`, `GetStopsTimes`), plus a small number of samples for other modes. No authentication was bypassed, none exists to bypass, and no automated or bulk collection was performed.
4. Searched for official documentation, terms, and third-party usage.

We did **not** call the internal, development or pre-production hosts embedded in the bundle (see §4.2).

---

## 3. Front-end behaviour

### 3.1 Routes [V]
From the bundle's `$stateProvider` configuration:

| Route | Purpose |
|---|---|
| `/stop/:codStop` | Stop detail with upcoming times |
| `/stop/:codStop/lang/:lang` | Same, language-specific (`es`, `en`) |
| `/stop/:codStop/map` | Stop on a map (Google Maps JS) |
| `/stop/:codStop/map/lang/:lang` | Same, language-specific |
| line, line-route, line-incidents, offices, around-me, night service | Other views |

### 3.2 Stop identifier format [V]
`{codMode}_{stopCode}`. For example, `8_16825` = mode **8**, stop **16825**.

Mode codes observed in the widget API and in CRTM GTFS:

| codMode | Network | Example |
|---|---|---|
| 4 | Metro de Madrid | `4_12` (Sol) |
| 5 | Cercanías | `5_122` (Sol) |
| 6 | EMT Madrid | `6_2711` (Sol-Sevilla) |
| 8 | Interurban buses | `8_16825` |
| 9 | Municipal urban buses (outside Madrid city) | line `9__3__106_` |
| 10 | Metro Ligero | `10_59` |

CRTM GTFS uses `par_{mode}_{code}` for stops (for example `par_8_09568`) and `{mode}__{line}___` for routes (for example `8__469___`). A mapping from widget IDs to GTFS IDs is straightforward. [V]

### 3.3 Refresh behaviour [V]
- **Stop detail (`StopDetailCtrl`)** loads stop information, then calls `GetStopsTimes` **once**. There is no `$interval` polling in that controller, so a user must reload the page to refresh.
- **Line route map (`LineRouteCtrl` and the map controllers)** polls `GetLineLocation.php` **every 15 000 ms** (`$interval(..., 15e3, 0)`) to update vehicle markers.
- A helper (`showIncomming`) treats arrivals at ≤ 0 minutes as "arriving".

### 3.4 Map
The widget uses the Google Maps JavaScript API (`google.maps.*`). MadridGo will not reuse this; we use MapLibre (see SOFTWARE_ARCHITECTURE.md).

---

## 4. Backend endpoints

### 4.1 Endpoints referenced by the production bundle [V]
All are relative to `Config.apiHost`, which is `/widgets/api/` in production:

| Endpoint | Parameters (as built in the bundle) | Purpose (inferred from use) |
|---|---|---|
| `GetStopsInformation.php` | `codStop` | Stop metadata and lines serving the stop |
| `GetStopsTimes.php` | `codStop, type, orderBy, stopTimesByIti` (stop page uses `1, 2, 3`) | Upcoming arrivals |
| `GetLineLocation.php` | `mode, codItinerary, codLine, codStop, direction` | Vehicle positions on a line |
| `GetLines.php` | `mode` / `codLine` | Lines |
| `GetLinesInformation.php` | `activeItinerary, codLine` | Line itineraries and stops |
| `GetLinesTimePlanning.php` | `codLine` | Service hours (night service) |
| `GetIncidentsAffectations.php` | `mode, codLine` | Line incidents |
| `GetStops.php` | `codStop` / `customSearch` / `postcode` / `codMunicipality` | Stop search |
| `GetNearestStopsByLocation.php` | `latitude, longitude, …` | Nearby stops |
| `GetMunicipalities.php`, `GetOffices.php` | – | Reference data |

### 4.2 Non-production hosts in the bundle [V]
The bundle embeds alternative `apiHost` values pointing at internal, development and pre-production environments (raw IP addresses, development and staging hostnames, and `localhost`). They are deliberately not listed here. **MadridGo must never call them.** They are recorded here only so that nobody mistakes them for a public API.

### 4.3 Server characteristics [V]
- `Server: Microsoft-IIS/10.0`, behind an Azure Application Gateway (`ApplicationGatewayAffinity` cookies).
- `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`.
- `Content-Type: application/json; charset=utf-8`.
- No CORS headers were observed. A third-party project reports the same, so browsers on other origins cannot call it directly ([busya](https://github.com/rzazo24/busya)).
- No authentication headers, API keys or tokens appear anywhere in the bundle.

---

## 5. Example: stop 8_16825

### 5.1 Stop information (`GetStopsInformation.php?codStop=8_16825`) [V]
```json
{"codStop":"8_16825","shortCodStop":"16825","codMode":"8",
 "name":"AV.LEGUARIO-LUIS CHAMIZO","postCode":"28981","codMunicipality":"4373",
 "coordinates":{"longitude":-3.7745438982466,"latitude":40.2252446507748},
 "lines":{"Line":[
   {"codLine":"8__469___","shortDescription":"469","description":"469-MADRID (Plaza Elíptica)-PARLA (Parla Este)","codMode":"8"},
   {"codLine":"9__3__106_","shortDescription":"3","description":"03-HOSPITAL-AVENIDA DE AMÉRICA-LAGUNA PARK","codMode":"9"}]},
 "access":2,"park":0,"nightLinesService":0}
```
The stop is in **Parla** (postcode 28981). It is served by interurban line **469** (mode 8) and Parla urban line **3** (mode 9). Neither line is EMT, so **EMT's official API does not cover this stop.**

### 5.2 Stop times (`GetStopsTimes.php?codStop=8_16825&type=1&orderBy=2&stopTimesByIti=3`) [V]
Request at 2026-11-09 13:59:49 CET (`actualDate` in the response):

| Line | Direction | Destination | `time` | `codVehicle` | Interpretation [I] |
|---|---|---|---|---|---|
| 3 | 1 | 9 DE JUNIO-HOSPITAL INFANTA CRISTINA | 14:05:42 | "" | likely real-time (second precision) |
| 3 | 1 | 9 DE JUNIO-HOSPITAL INFANTA CRISTINA | 14:30:17 | "" | likely real-time |
| 469 | 1 | MADRID (Intercambiador Plaza Elíptica nivel -2) | 14:33:25 | "" | likely real-time |
| 3 | 1 | 9 DE JUNIO-HOSPITAL INFANTA CRISTINA | 15:21:00 | "" | likely scheduled (round minute) |
| 469 | 1 | MADRID (Intercambiador Plaza Elíptica …) | 15:54:00 | "" | likely scheduled |
| 469 | 1 | MADRID (Intercambiador Plaza Elíptica …) | 16:54:00 | "" | likely scheduled |

Fields on each time entry: `line`, `direction`, `destination`, `destinationStop`, `time` (absolute ISO-8601 with offset), `codVehicle`, `codIssue`. [V]

### 5.3 What the response does **not** contain [V]
- No explicit flag distinguishing a prediction from a scheduled time.
- No per-arrival observation timestamp. There is only the response-level `actualDate`, which is generation or retrieval time, **not** the time the vehicle position was observed.
- No scheduled time alongside the predicted time, so delay cannot be computed from this response alone.
- No vehicle identifier (`codVehicle` is empty in this sample).
- `codIssue` is undocumented; its meaning is unknown. [U]

A third-party developer reports the same problem: CRTM returns absolute times and "does not clearly distinguish real-time from scheduled" ([busya](https://github.com/rzazo24/busya)). A web-search summary also attributed to CRTM's official app the statement that not all interurban lines provide waiting times, depending on the concessionaire. **We could not locate the primary source for that statement.** [U]

### 5.4 Other modes (single samples, same time) [V]
- **Metro `4_12` (Sol):** 14 entries with second-precision times. This suggests CRTM's backend holds Metro predictions. [I]
- **Cercanías `5_122` (Sol):** returned the **same Metro entries** as `4_12`, not Cercanías trains. This looks like a station-level aggregation or an anomaly, and shows the API can return surprising results. [V observation / U cause]
- **EMT `6_2711`:** 1 entry (line 15, 14:10:01).
- **Metro Ligero `10_59`:** 0 entries.

---

## 6. Data sources behind the widget

| Mode | Likely origin | Evidence |
|---|---|---|
| Interurban and urban buses | Operators' fleet management systems (SAE/AVL), consolidated by CRTM | CRTM press release, 17-04-2026: real-time bus position and waiting times from the operators' SAE are now integrated into Google Maps for "todos los autobuses urbanos e interurbanos" ([CRTM](https://crtm.es/comunicacion/sala-de-prensa/noticias/noticias/17042026-la-comunidad-de-madrid-incorpora-por-primera-vez-la-posicion-en-tiempo-real-de-los-autobuses-interurbanos-en-google-maps/?lang=en)) [V] |
| Metro | Metro de Madrid systems, via CRTM / CITRAM | CRTM runs CITRAM, a 24/7 control centre supervising all modes ([crtm.es/conocenos](https://crtm.es/conocenos/)) [V]; the link to the widget is [I] |
| EMT | EMT systems | [I] |

The Google Maps integration strongly suggests CRTM already produces a consolidated real-time feed for urban and interurban buses. Google Transit partners normally deliver real-time data as GTFS Realtime. **The press release does not state the format, and does not say whether the feed is available to other parties.** [V that it's unstated; I that it's probably GTFS-RT]

---

## 7. Legal and usage assessment

| Classification | Applies? | Notes |
|---|---|---|
| Publicly documented API | **No** | No documentation found. |
| Officially supported third-party interface | **No** | Not listed on datos.crtm.es, crtm.es "Muévete por Madrid", or the CRTM licence page. |
| Publicly accessible website request | **Yes** | Served without authentication to every browser. |
| Undocumented internal endpoint | **Yes** | The same endpoints are the widget's private backend. |

Relevant licence text, from https://www.crtm.es/licencia-de-uso [V]:
- Scope: "Descarga de datos calificados como **estáticos** de la parte pública de la web del CRTM."
- Commercial reuse allowed; attribution "Powered by CRTM" with a link is required; data must be kept up to date; no implied endorsement.
- CRTM may block reusers whose usage it detects as abusive.
- The page does not mention real-time data or APIs.

Third-party wrappers that call the widget API exist ([crtm_poll](https://crtm-poll.readthedocs.io/en/latest/crtm_poll.crtm_api.html), [citram-python-api](https://pypi.org/project/citram-python-api/1.0.2/), [@dubisdev/crtm-api](https://awesome.ecosyste.ms/projects/github.com%2Fdubisdev%2Fcrtm-api), [busya](https://github.com/rzazo24/busya)). **Their existence does not establish permission.** One of them explicitly warns that it is not a documented public API and can change without notice.

**Conclusion:** Using `/widgets/api/` in MadridGo is **not authorized** on current evidence. It may be used during Phase 0 only for understanding, with single manual requests, as done here. It must not be used in development pipelines or in production unless CRTM grants written permission.

---

## 8. Recommended action: request access from CRTM

Ask CRTM, in writing, for one of the following, in order of preference:
1. Access to the **GTFS-Realtime (or SIRI) feed** that CRTM supplies to Google Maps for urban and interurban buses (TripUpdates, VehiclePositions, ServiceAlerts), under an open-data or reuse licence.
2. Written permission to consume `/widgets/api/` (`GetStopsTimes`, `GetLineLocation`, `GetIncidentsAffectations`) at an agreed rate, with documentation of the real-time flag, `codIssue` and timestamp semantics.
3. Metro and Metro Ligero real-time data under the same terms.

**Contact:** CRTM's licence page names **`opendata@crtm.es`** for open-data user registration, with "Usuario datos abiertos" as the subject (https://www.crtm.es/licencia-de-uso?lang=en). This address was confirmed directly in the licence page HTML on 2026-11-09. [V] A search summary claimed that `crtm_contacto@madrid.org` appears in a CRTM metadata PDF, but this **could not be verified**: the PDF text is not extractable, and an exact-match web search found no page listing it. **Do not use it.** [U] Other CRTM addresses (procurement, documentation centre, Data Protection Officer `crtm_protecciondatos@madrid.org`) are not the right channel for data access. If `opendata@crtm.es` does not reply, use the contact form on https://www.crtm.es/.

**Operators (secondary contacts):** line 469 and Parla urban line 3 run under concession VCM-403, held by **Avanza Movilidad Integral, S.L.** (Parla municipal notice, July 2025, via search). Metro Ligero: ML2/ML3 are run by **Metro Ligero Oeste S.A.**; ML1 is run by **Metros Ligeros de Madrid** (possibly a Metro de Madrid subsidiary [U]); ML4 is the **Tranvía de Parla**. CRTM aggregates all of their data, so it remains the primary contact.

Suggested request (Spanish, to be sent by the project owner):

> Asunto: Solicitud de acceso a datos en tiempo real para reutilización — aplicación MadridGo
>
> Estimados Sres.:
>
> Estamos desarrollando MadridGo, una aplicación móvil de información de transporte público para la Comunidad de Madrid. Ya reutilizamos los datos GTFS estáticos del CRTM conforme a la Licencia de datos abiertos y estáticos, con la atribución "Powered by CRTM".
>
> Tras la incorporación de la posición y los tiempos de espera en tiempo real de los autobuses urbanos e interurbanos a Google Maps (nota de prensa del 17/04/2026), solicitamos información sobre:
> 1. Si existe un feed GTFS-Realtime o SIRI (TripUpdates, VehiclePositions, alertas) disponible para reutilizadores, y en qué condiciones.
> 2. En caso contrario, si podemos consumir el servicio de los widgets (crtm.es/widgets/api) y con qué límites de uso, así como el significado de los campos que distinguen tiempos estimados y programados.
> 3. La disponibilidad de datos en tiempo real de Metro de Madrid y Metro Ligero.
>
> Nos comprometemos a respetar las condiciones de atribución, frecuencia de consulta y actualización que nos indiquen.
>
> Atentamente,
> [Nombre, contacto]

---

## 9. Implications for MadridGo design

Even with authorization, the current widget data is **insufficient for SBB-level reliability labelling**:
- Without an explicit real-time flag, MadridGo would have to guess (second-precision heuristic) whether a time is a prediction. **The product rules forbid presenting a guess as fact.** If the heuristic is ever used, the UI must label it "probably real-time" and the classification must be validated against a ground-truth sample.
- Without a scheduled-time field, delay cannot be shown.
- Without an observation timestamp, freshness cannot be computed per arrival; only "retrieved at" can be shown.

These are exactly the questions to put to CRTM (§8). A GTFS-RT feed would resolve all of them, because GTFS-RT carries `delay`, `time`, `timestamp` and `schedule_relationship`.

## 10. Open questions [U]
1. Does CRTM publish, or will it share, the feed sent to Google Maps?
2. What do `type`, `orderBy`, `stopTimesByIti` and `codIssue` mean?
3. Which interurban and urban concessionaires actually supply real-time data?
4. What is the real update cadence of predictions at the source?
5. Why does `5_122` return Metro departures?
