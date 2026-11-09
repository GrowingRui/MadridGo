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

## Phase 3 — Real-time (L)
- Adapter framework (fetch, normalize, cache, breaker, metrics).
- Renfe GTFS-RT adapter plus OTP GTFS-RT updater (TripUpdates, Alerts, VehiclePositions).
- EMT adapter (on-demand per stop).
- Freshness engine and 7-day calibration.
- Alerts: Renfe GTFS-RT, EMT RSS.
- CRTM adapter **implemented against recorded fixtures only, disabled**, so it can be activated in days if authorized.
- **Exit:** reliability scenarios R1–R9, R13–R15 pass.
- Depends on: Phase 2; EMT registration.

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
