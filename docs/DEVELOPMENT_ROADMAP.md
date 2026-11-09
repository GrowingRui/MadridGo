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
- Tests: R1–R9 and R13–R15 pass (`tests/test_reliability_scenarios.py`), against recorded Renfe feeds from 2026-11-09. R6 covers the stop-board notice; blocking routing on expired feeds is part of Phase 4 `/journeys`. R1's transfer label is Phase 4.
- First live poll: 75 Madrid trip updates, feed 8 s old, 100 % trip match.
- **Blocked: EMT login.** MobilityLabs refuses the application credentials (HTTP 403, code 84, undocumented) on both v1 and v2 login, because EMT has not yet approved the MadridGo application (confirmed by the project owner, 2026-11-09). The EMT adapter is built and tested against EMT's documented response format; boards show "EMT live data unavailable" until the account or app is activated. Field verification (§3 of DATA_SOURCE_ANALYSIS.md) is still open.
- **Open: 7-day freshness calibration.** Every poll is recorded in `adapter_health`; run `python -m app.realtime calibrate` after 7 days of the worker running.
- **Deferred:** CRTM adapter, until CRTM replies (their answer decides the interface); prediction-accuracy sampling (Phase 6 input).

## Phase 4 — Journey planner API (M)
- `/journeys` with ranking options (fastest, fewest transfers, least walking, earliest arrival).
- Transfer reliability labels; EMT stop-level live overlay on journey legs.
- **Exit:** Journey API contract tests pass; p95 < 3 s.

## Phase 5 — Mobile app (L)
- Original MadridGo design system: colour, typography, iconography, and mode colours that respect official line colours from GTFS.
- Screens: Home/Planner, Results, Details, Stop board, Map (MapLibre + OpenFreeMap), Favorites, Settings, Attribution/About.
- On-device favorites, recents, Home and Work. ES/EN i18n. Accessibility pass.
- **Website:** the same screens, with a responsive layout for desktop widths and a web map (MapLibre GL JS if the RN module lacks web support).
- **Exit:** usability test with 5 users; all labels per RELIABILITY_STRATEGY.md visible.

## Phase 6 — Reliability and notifications (L)
- Journey monitoring, disruption detection, re-planning.
- Expo push notifications, commuter routes.
- Prediction accuracy pipeline (needs weeks of data; start sampling in Phase 3).
- **Exit:** R10–R12 pass; real-device notification tests.

## Phase 7 — Production preparation (M)
- Security review (OWASP MASVS-lite, dependency audit), GDPR privacy policy, in-app attribution.
- VPS deployment (Docker Compose, Caddy TLS, backups, uptime monitoring).
- App Store / Google Play listings, privacy labels, review.

## Critical path
CRTM response → (interurban live data) and Metro GTFS → (Metro routing). Everything else can proceed without them. The MVP ships without CRTM real-time if no authorization arrives, with clear labels.
