# Security review (Phase 7 groundwork)

Done 2026-11-22 by reading the code and running the dependency audits. It is a first pass, not a
penetration test: it should be repeated on the deployed system and before each store submission.

## Dependency audit

| Part | Tool | Result |
|---|---|---|
| API (30 packages as installed in the container) | `pip-audit` | No known vulnerabilities. |
| App (`npm audit --omit=dev`) | `npm audit` | 5 moderate: `glob` / `minimatch` inside `@expo/cli` (Expo's build tooling). Not part of the shipped app; the only automatic fix downgrades Expo to 52, so it is **not** applied. Re-check after each Expo SDK upgrade. |

Repeat both before every release. Phase 7 adds them to CI.

## What is already in good shape

- **No accounts, no passwords, no tokens.** The API is read-only (`allow_methods=["GET"]`).
- **No analytics, ads or crash-reporting libraries** in the app or the API.
- **Secrets**: `.env` is git-ignored; nothing secret is in the tracked files or in git history
  (checked for the EMT keys). `POSTGRES_PASSWORD` has no default (compose refuses to start without it).
- **SQL**: all user input goes through `$n` parameters; the few composed queries use only constants
  and integer ids (lint rule `S608` is switched off for exactly those two files, with a comment).
- **Input limits**: coordinates are limited to the Madrid area, `limit` and `radius_m` have maximums.
- **Untrusted XML** (EMT incidents) is parsed with `defusedxml`.
- **Container** runs as a non-root user (uid 10001). Postgres, Redis and OTP are bound to
  `127.0.0.1` only.
- **Location** is asked for only when the user taps "Current location" (or, on Departures, when
  access was already granted; it never prompts by itself). The application does not store it,
  **but the web server's access log does (finding 1)**.

## Findings to fix before launch

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **High** (fixed in code 2026-11-23) | **Access logs contain location.** uvicorn logs every request with its full URL, so `GET /stops/nearby?lat=40.42&lon=-3.70` is written to the log with the client's IP address (confirmed 2026-11-22). That is personal data the privacy policy must not claim to avoid. | Switch off uvicorn's access log in production (`--no-access-log`) and log only method, path without query, status and duration from our own middleware; the same for Caddy's log (drop the query string and truncate IPs). Keep logs 14 days at most. |
| 2 | Medium | **No rate limiting.** Anyone can hammer `/stops/search`, `/places/search` (which calls CartoCiudad) or `/trains/live` (which reads OTP). | Rate limit per IP at the reverse proxy (Caddy) and a small per-IP limit on the places search; cache `/trains/live` for a few seconds server-side. |
| 3 | Medium | **API port is published on all interfaces** (`api` service, for phones on the LAN in development). | In production compose, publish nothing: only Caddy (TLS) is reachable. Use `127.0.0.1` binding or no `ports:`. |
| 4 | Medium (fixed 2026-11-23) | **Map library loaded from unpkg.com without Subresource Integrity** (`mapHtml.ts`). If unpkg were compromised the map page could run foreign code. | Add an `integrity` hash for the pinned version (5.24.0), or bundle the library with the app. |
| 5 | Low | **CORS** defaults to the Expo dev server and allows any request header. | Production: set `MADRIDGO_CORS_ORIGINS` to the real web origin only. |
| 6 | Low (fixed in code 2026-11-23) | `/health` reports the PostGIS version and `/docs` is public. | Production: serve `/health` details only to the monitor, or drop the detail string; disable `/docs` and `/openapi.json`. |
| 7 | Low | No security headers on the web build. | Caddy: `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, and a Content-Security-Policy that allows the tile and geocoder hosts. |
| 8 | Low (fixed 2026-11-23) | No dependency audit in CI. | Add `pip-audit` and `npm audit --omit=dev` to the GitHub workflow (fail on high). |
| 9 | Info | Backups, uptime monitoring and log retention do not exist yet. | Phase 7 (VPS): nightly Postgres dump off the server, uptime check on `/health`, logs kept 14 days at most. |

## Status of the fixes (2026-11-23)

- **#1** The API image starts uvicorn with `--no-access-log`; `app/accesslog.py` logs
  `METHOD /path status ms` only (no query string, no client address; `tests/test_access_log.py`).
  Still to do with the production setup: Caddy's own access log (drop the query, truncate IPs) and
  14-day retention.
- **#4** The map page checks MapLibre with Subresource Integrity hashes (`MAPLIBRE_SRI` in
  `mapHtml.ts`, tested; checked in Chrome that the right hash runs the script and a wrong one blocks it).
  Bundling the library with the app remains an option for the store builds.
- **#6** With `MADRIDGO_ENVIRONMENT=production` `/docs`, `/redoc` and `/openapi.json` answer 404 and
  `/health` no longer reports the PostGIS version.
- **#8** CI runs `pip-audit --skip-editable` and `npm audit --omit=dev --audit-level=high`.
- Open (production setup): #2, #3, #5, #7, #9 and the Caddy half of #1.

## Privacy-relevant data flows (for the privacy policy)

- The app sends to MadridGo's API: search text, the stop being looked at and, only when the user
  asks, the coordinates of "Current location". Requests are not tied to an account or device id, but the server's access log sees the IP address and URL until finding 1 is deployed (the code fix is done).
- The API forwards address searches (only the text and a fixed Madrid-area filter; not the user's position) to **CartoCiudad** (IGN, Spain).
  CartoCiudad sees the API server's address, not the user's.
- The map in the app loads tiles from **OpenFreeMap** and the map library from **unpkg.com**; those
  hosts see the user's IP address. (Finding 4 makes sure unpkg can only serve the exact pinned file.)
- Saved stops, saved routes, recent searches, language and settings, and offline copies stay **on
  the device**.
- The server keeps timetable and live-data statistics (accuracy sampling) that contain no
  personal data.

## Not covered yet

Penetration test of the deployed system, mobile-binary checks (OWASP MASVS-lite on a release
build: certificate handling, backups, debuggable flag), and a store-listing data-safety review.
