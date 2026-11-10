# Development Roadmap

**Status:** Phase 0 complete pending approval, 2026-11-09. Complexity: S (≤ 2 days), M (≤ 1 week), L (≤ 3 weeks), XL (> 3 weeks), for one developer.

## Parallel non-code track (start now, owner: project owner)
| Action | Why | Blocks |
|---|---|---|
| Send the CRTM real-time access request (template in CRTM_WIDGET_ANALYSIS.md §8) and ask about the **expired Metro GTFS** | Interurban/urban live arrivals (stop 8_16825) and Metro routing depend on it | Phase 3 CRTM adapter; Metro routing |
| Register on EMT MobilityLabs and create an app | Needed for EMT key | Phase 3 EMT adapter |
| Confirm Renfe TU/VP licence on data.renfe.com | Licence certainty | Production release |

## Phase 1 — Architecture and foundation (M)
- Monorepo: `apps/mobile` (Expo + TS), `services/api` (FastAPI), `services/workers`, `infra/` (Docker Compose), `docs/`.
- Docker Compose: PostGIS, Redis, API.
- FastAPI `/health` (checks DB and Redis), OpenAPI, pytest, ruff, mypy.
- Expo app with dev build config, a single screen calling `/health`.
- GitHub Actions CI: lint, type-check, tests.
- `.env.example`, secrets policy, licence/attribution file.
- **Exit:** `docker compose up` gives a healthy API; the mobile app shows API status; CI is green.

## Phase 2 — Static data (L)
- Downloaders for six CRTM GTFS items, the EMT GTFS and the Geofabrik Madrid OSM extract.
- MobilityData GTFS validator in the pipeline; versioned import into PostGIS; expiry alarms.
- Stop search (trigram) and nearby stops (PostGIS).
- OTP container: graph build from feeds + OSM; measure RAM and time.
- **Decision point:** Metro GTFS handling (risk R1).
- **Exit:** Parla → Atocha query returns a Cercanías C-4 itinerary; validator reports archived.
- Depends on: Phase 1.

**Status (2026-11-09): exit criteria met, pending review.**
- All six CRTM feeds import in about 1.5 min in total (largest: EMT, 2.2 M stop times, 33 s). Imports are versioned and atomic, two versions are kept, and partial imports are cleaned up.
- Validator v8.0.1 results (reports in `data/validation/`): Metro, ML, Cercanías and EMT have 0 errors. Interurban has 226 errors and urban 2,557, almost all `stop_time_with_arrival_before_previous_departure_time`. They are imported anyway, with the status recorded in `feed_version`.
- OTP 2.10.0: graph build takes 4 min 12 s (5 GB heap); the graph is 279 MB; serving uses about 1.8 GB of RAM; a cold query takes 3.7 s. From stop 8_16825 to Atocha it returns C4a/C4b itineraries, with bus 3 or ML4 feeders.
- Renfe GTFS-RT trip IDs match static IDs exactly (see DATA_SOURCE_ANALYSIS.md §4).
- Stop boards answer in under 0.3 s for the largest interchange (Plaza de Castilla).
- **Open decision (risk R1):** the Metro GTFS is still expired (last updated 2025-05-30). Metro gets no scheduled times and no routing; the app says so in red on affected stop boards. The options are listed in DATA_SOURCE_ANALYSIS.md §2.2.
- Deferred: `shape` table (needed for the Phase 5 map), `stop_mapping` (Renfe ↔ CRTM station links) and `transfer_rule`.

## Phase 3 — Real-time (L)
- Adapter framework (fetch, normalize, cache, breaker, metrics).
- Renfe GTFS-RT adapter plus OTP GTFS-RT updater (TripUpdates, Alerts, VehiclePositions).
- EMT adapter (on-demand per stop).
- Freshness engine and 7-day calibration.
- Alerts: Renfe GTFS-RT, EMT RSS.
- CRTM adapter **implemented against recorded fixtures only, disabled**, so it can be activated in days if authorized.
- **Exit:** reliability scenarios R1–R9, R13–R15 pass.
- Depends on: Phase 2; EMT registration.

**Status (2026-11-09): in progress, pending review.**
- Done: adapter framework (`app/realtime/`: timeouts, 2 retries with backoff, 429 back-off, circuit breaker, shared Redis cache, request coalescing); Renfe GTFS-RT worker (`python -m app.realtime run`, compose service `realtime`, 30 s); OTP GTFS-RT updaters (trip updates, alerts, vehicle positions; OTP applies all Madrid trips); EMT on-demand adapter; alerts (Renfe GTFS-RT, EMT RSS) on stop boards and `GET /alerts`; `GET /realtime/status`; app shows live/delay/cancelled/platform and per-operator data status.
- Tests: R1–R9 and R13–R15 pass (`tests/test_reliability_scenarios.py`), against recorded Renfe feeds from 2026-11-09. R6 covers the stop-board notice; blocking routing on expired feeds and R1's transfer label are covered by the Phase 4 tests (`tests/test_journeys.py`).
- First live poll: 75 Madrid trip updates, feed 8 s old, 100 % trip match.
- **Blocked: EMT login.** MobilityLabs refuses the application credentials (HTTP 403, code 84, undocumented) on both v1 and v2 login, because EMT has not yet approved the MadridGo application (confirmed by the project owner, 2026-11-09). The EMT adapter is built and tested against EMT's documented response format; boards show "EMT live data unavailable" until the account or app is activated. Field verification (§3 of DATA_SOURCE_ANALYSIS.md) is still open.
- **Open: 7-day freshness calibration.** Every poll is recorded in `adapter_health`; run `python -m app.realtime calibrate` after 7 days of the worker running.
- **Deferred:** CRTM adapter, until CRTM replies (their answer decides the interface); prediction-accuracy sampling (Phase 6 input).

## Phase 4 — Journey planner API (M)
- `/journeys` with ranking options (fastest, fewest transfers, least walking, earliest arrival).
- Transfer reliability labels; EMT stop-level live overlay on journey legs.
- **Exit:** Journey API contract tests pass; p95 < 3 s.

**Status (2026-11-09): exit criteria met, pending review.**
- `GET /journeys` (`app/journeys.py`, OTP client in `app/otp.py`): from/to as stop ids or coordinates, departure or arrival time (`arrive_by`), sort options `earliest_arrival` (default), `fastest`, `fewest_transfers`, `least_walking` (OTP preferences shift the candidates, then results are sorted), Earlier/Later via OTP page cursors.
- Live times on legs come only from MadridGo's own freshness-checked sources (Renfe snapshot, EMT arrivals), with provenance. OTP's own real-time fields are ignored because OTP does not report their age; walks next to a delayed train are moved to match. Renfe live data is matched only to legs within −2 h…+3 h of now (trip IDs repeat daily).
- EMT stop-level overlay: an EMT leg leaving within 45 min boards the first live bus of its line you can still reach (at most 6 EMT stops per request, shared cache). No delay is shown, because EMT is headway-based. It stays inactive until EMT approves the MobilityLabs application.
- Transfer labels (`app/transfers.py`) per RELIABILITY_STRATEGY.md §5, with a per-mode allowance for arrivals without live data (initial proposal: bus 2 min, rail/metro/light rail 1 min). Changes onto frequency services are "wait up to N min". Cancelled or missed connections make a journey `feasible: false`; it is listed after the alternatives.
- R6: routes of expired feeds are excluded in the OTP request and any itinerary still using one is dropped. A notice says so (Metro today).
- App: Plan and Journey screens use `/journeys`; the preview data is removed.
- Tests: 39 contract and reliability tests on real OTP answers recorded 2026-11-09 (`tests/test_journeys.py`, fixtures in `tests/fixtures/otp/`), covering R1 transfer labels, R2, R4, R6, R10 (live delay makes a change not feasible) and R13. Integration test against the real stack: **median 0.44 s, p95 1.29 s** over 24 requests on 8 routes (`tests/test_journeys_integration.py`).
- **Not in Phase 4:** re-planning from the next stop (R12) and simultaneous disruptions (R11) are Phase 6. Curated station change times (`MIN_CHANGE_S`) start empty.

## Phase 5 — Mobile app (L)
- Original MadridGo design system: colour, typography, iconography, and mode colours that respect official line colours from GTFS.
- Screens: Home/Planner, Results, Details, Stop board, Map (MapLibre + OpenFreeMap), Favorites, Settings, Attribution/About.
- On-device favorites, recents, Home and Work. ES/EN i18n. Accessibility pass.
- **Website:** the same screens, with a responsive layout for desktop widths and a web map (MapLibre GL JS if the RN module lacks web support).
- **Live train position in the journey timeline** (requested 2026-11-09, like SBB Mobile; **built 2026-11-10**: `GET /trips/{trip_id}/position` in `app/trips.py`, timeline in `components/journey.tsx`, rules in `utils/trainPosition.ts`): a small moving point on the line of the journey timeline shows where the train is now.
  - Before boarding: the point sits on the line above the boarding stop, with "Train is 2 stops away · Getafe Centro".
  - While riding: the leg's intermediate stops open automatically and the point sits at the station where the train stands, or between the two stations it is travelling between (placed from its GPS position along the line).
  - The age is shown ("position 20 s ago"). Positions follow the freshness rules: when the data is STALE (over 3 min) the point is hidden, never shown in an old place.
  - Backend: a light endpoint (for example `GET /trips/{trip_id}/position`) read from the cached Renfe snapshot: status (stopped at, arriving, between stations), previous and next stop, position between them, freshness. The app polls it every 30 s while a journey is open, without re-running the route search.
  - Coverage: **Cercanías now** (Renfe GTFS-RT vehicle positions: on 2026-11-09, 70 of 70 trains had GPS and matched their timetable trip, data 17 s old). EMT buses once EMT approves the MobilityLabs application, if its API includes bus positions (to verify). Interurban and urban buses only if CRTM authorizes real-time data. Metro and Metro Ligero publish no positions.
  - **Decided 2026-11-10 (after looking at SBB):** SBB places vehicles from real-time departure and arrival times, so its point keeps moving. A live check of Renfe's feed showed that its positions are mostly the coordinates of the last station, kept until the next one, so pure "glide to each update" would make the point jump station to station. MadridGo mixes both: each update places the point (GPS when off the station, otherwise Renfe's predicted times) and it glides there; between updates it moves on at the timetable pace for at most 45 s and never onto the next station, so a train held at a signal stops the point within seconds; a train at a station stays on it; the point never moves backwards (Renfe positions sometimes step back a station); STALE data hides it. "Reduce motion" makes it jump instead of moving.
  - **Estimated position (added 2026-11-10 at the user's request, as in SBB):** every Cercanías train gets a point, not only those Renfe reports. Without a usable live position, the server places the train from the timetable (plus Renfe's live delay when known) and the point moves continuously with the clock, leaving each station at its estimated departure. Live positions placed from Renfe's predicted times also move continuously. Estimated points are hollow and labelled "Estimated from the timetable" (or "Estimated · timetable + N min live delay"); live points are solid with "Live · position N s ago". Limitation: a train that is not running but not marked cancelled (e.g. during a strike) still gets an estimate, which is why the label matters.
  - The same data drives moving trains on the Map screen.
  - Estimate: 1–2 days.
- **Trip screen** (built 2026-11-10, PR #5: `GET /trips/{trip_id}` in `app/trips.py`, `app/trip.tsx`, `components/trip.tsx`): tapping a ride in the journey timeline opens the train's whole route, from its first stop to its terminus. The passenger's section is drawn in the line colour, stops already passed are grey, and the same live or estimated point moves along it.
- **Approach dot:** when the train is one stop before the boarding stop, the point now slides down towards the boarding stop instead of waiting at the previous station.
- **Train direction from the terminus:** Renfe's GTFS has no headsign, so legs used to fall back to the passenger's destination as "Direction", which could be wrong. The API now gives the trip's last stop as the direction, and the app never shows the destination there.
- **SBB-style Plan screen** (built 2026-11-10, PR #10): the Plan header asks "Where to?" and switches between three views: **Timetable**, **Touch timetable** and **Map**.
  - **Search list** for From/To, as in SBB: "Current location" first, then starred stops (★), then recent stops (🕒, with a ☆ to star them). Search results can be starred too. Stars and recents are kept on the device.
  - **Current location** plans from the phone's position (`from_lat`/`from_lon`; the server names the start "Your location"). Location is asked for only when used.
  - **Touch timetable** (`components/touch.tsx`): tiles for starred and recent stops (up to 10). Tap one then another, or drag from one to the other, to plan that trip. Edit removes tiles.
  - **Map** (`components/planMap.tsx`; MapLibre 5 + OpenFreeMap): stops around you from zoom 14, a locate button, stop search, and a popup that opens the stop's departures. This is a stop map only; the live train map below is still postponed.
  - **Saved tab removed**: starred stops live in the search list and the touch timetable, so the separate tab (and the website's Saved link) is gone.
- **Live train map** (Map screen; **postponed 2026-11-10 by the project owner** until the other Phase 5 items are done): a map of Madrid, like Flightradar24 for trains. Cercanías lines in their colours, every running Cercanías train as a dot that moves along its line (solid = live GPS, hollow = estimated from the timetable, same rules and labels as the journey timeline). Tapping a train shows line, direction and position age, and opens its trip screen; tapping a station opens its board. Reuses `GET /trips/{trip_id}/position`; needs the deferred `shape` table for line geometry. App: MapLibre + OpenFreeMap; website: MapLibre GL JS. Metro shows lines and stations only (no positions published); EMT buses if EMT's API includes positions; interurban buses only with CRTM authorization. Estimate: a few days.
- **Features taken from SBB Mobile** (reviewed 2026-11-10; added at the project owner's request). In suggested order:
  1. **Done (PR #9).** **Line alerts on the connection card:** an active operator alert for a line used by a connection is shown on the connection row, not only inside the journey. Found in testing on 2026-11-10: during a Renfe strike (alert: "No circulan trenes de líneas C3, C-4 y C-5"), C-4 connections still showed as Scheduled with an estimated train point. Small.
  2. **Done (PR #10).** **Nearby stops:** "Stops near me" in the planner and Departures, from the phone's location (asked only when used). `GET /stops/nearby` already exists. Small. Built as "Current location" in the search list and in Departures, which lists the stops around you.
  3. **Home and Work, favourite trips** (SBB's personal timetable): one tap plans "home → work"; saved trips appear as quick picks. Stored on the device. **Decided 2026-11-10: optional, for later**; starred stops and the touch timetable cover most of it.
  4. **Disruptions page:** all current Renfe and EMT alerts, grouped by line, reachable from Plan and Departures.
  5. **Extra time for changes:** a connection option for people who change slowly (luggage, pram, wheelchair), using the route planner's extra transfer time; transfer labels use the extra time. **Decided 2026-11-10: not now.**
  6. **Share a connection and add it to the calendar.** Small, no data needed.
  7. **Dark mode** (already in DESIGN_SYSTEM.md), next to "reduce motion" and the screen-reader work of the accessibility pass.
  - Later, once the app is on stores: home-screen widgets for saved trips (needs a development build).
  - **Not possible with Madrid's data today:** occupancy forecasts, train formation and platform sectors (Renfe publishes neither). **Out of scope:** tickets and travelcards (no public ticketing interface for the Tarjeta Transporte Público).
- **Exit:** usability test with 5 users; all labels per RELIABILITY_STRATEGY.md visible.

## Phase 6 — Reliability and notifications (L)
- Journey monitoring, disruption detection, re-planning.
- Expo push notifications, commuter routes. As in SBB Mobile: alerts for a saved journey (delay, cancellation, platform change, change no longer possible) and for regular commuter routes on chosen days and times.
- Prediction accuracy pipeline (needs weeks of data; start sampling in Phase 3).
- **Exit:** R10–R12 pass; real-device notification tests.

## Phase 7 — Production preparation (M)
- Security review (OWASP MASVS-lite, dependency audit), GDPR privacy policy, in-app attribution.
- VPS deployment (Docker Compose, Caddy TLS, backups, uptime monitoring).
- App Store / Google Play listings, privacy labels, review.

## Critical path
CRTM response → (interurban live data) and Metro GTFS → (Metro routing). Everything else can proceed without them. The MVP ships without CRTM real-time if no authorization arrives, with clear labels.
