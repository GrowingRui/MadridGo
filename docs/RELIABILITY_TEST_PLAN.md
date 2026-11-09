# Reliability Test Plan

**Status:** Phase 0, 2026-11-09. No tests exist yet. Nothing here is reported as passing until it has been executed in CI.

## 1. Test levels and tools
| Level | Tool | Runs |
|---|---|---|
| Unit (backend) | pytest, hypothesis (property tests for time math) | Every commit |
| Unit (mobile) | Jest + React Native Testing Library | Every commit |
| Integration | pytest + Docker Compose (PostGIS, Redis, OTP with a **small fixture graph**) | Every PR |
| Contract | Recorded real responses (fixtures) per source, replayed via `respx`; schema validated with Pydantic | Every PR |
| Live smoke | Real Renfe GTFS-RT; EMT with key; nightly only, never in PR CI | Nightly |
| Reliability (fault injection) | Fixture-driven scenarios plus `toxiproxy` for timeouts and latency | Every PR (fast set), nightly (full) |
| Performance | k6 or Locust against the local stack | Before each release |

## 2. Unit tests
| Area | Cases |
|---|---|
| GTFS parsing | BOM handling; frequency trips; times > 24:00:00; `calendar_dates` add and remove; missing optional files; expired calendar detection |
| Normalization | ID mapping (`8_16825` ↔ `crtm:par_8_16825`); Renfe stop IDs; duplicate stop names |
| Timestamps | UTC ↔ Europe/Madrid; **DST transitions** (last Sunday of March and October); service day crossing midnight; GTFS-RT epoch seconds |
| Delay calculation | predicted − scheduled; negative delay (early); missing schedule → delay `null` (not 0) |
| Freshness | Each state boundary; null `source_ts` falls back to `retrieved_at` **with flag** |
| Transfer labels | Each label boundary in RELIABILITY_STRATEGY.md §5; cancelled connection → Not feasible |
| API validation | Every response model rejects a live classification without `source` and `retrieved_at` |

## 3. Integration tests
- **Static ingestion:** import the fixture subsets of all six CRTM feeds; validator gate blocks a corrupted feed; blue/green switch keeps the old version on failure.
- **Renfe GTFS-RT:** recorded `.pb` → observations; trip matching rate ≥ 95 % on the fixture.
- **EMT:** recorded responses → observations; token expiry and refresh; 401 handling.
- **OTP:** fixture graph (a few Parla/Atocha stops plus Cercanías C-4 plus one EMT line) returns a known itinerary; GTFS-RT delay shifts the itinerary.
- **Database:** PostGIS nearest-stop query; partition creation; retention job.
- **CRTM adapter:** exists but `enabled=false`. A test asserts that **no environment config enables it** without an `authorization_ref` value.

## 4. Reliability scenarios

Each scenario has a fixture, an expected API output and an acceptance criterion.

| # | Scenario | Expected behaviour | Acceptance |
|---|---|---|---|
| R1 | Delayed bus/train (+7 min) | Live time shown, delay "+7", transfer label recomputed | Correct time ±0 s; label correct |
| R2 | Cancelled trip (`CANCELED`) | Departure marked Cancelled; journeys using it flagged Not feasible; alternative offered | 100 % of affected journeys flagged |
| R3 | Missing real-time updates (source returns no entity for a trip) | Falls back to Scheduled with label | No live badge |
| R4 | Stale observations (source_ts 10 min old) | Labelled Outdated, schedule shown | **Never** labelled Live |
| R5 | Source timestamp in the future (clock skew) | Clamp, flag anomaly, log | No negative ages displayed |
| R6 | Incorrect scheduled data (expired calendar) | Routing for that feed blocked; banner "timetable unavailable" | No itinerary uses the expired feed |
| R7 | API timeout | Retry ×2, then serve cache with true age, or Unavailable | Response < 6 s; correct label |
| R8 | HTTP 429 with Retry-After | Back off for the specified time; no extra upstream calls | Upstream call count as expected |
| R9 | Circuit breaker | After 5 failures, no upstream calls for 30 s; half-open probe | Verified by call counter |
| R10 | Missed transfer (arriving leg delay > margin) | Transfer becomes Not feasible; alternatives returned | Alternative's first departure ≥ now |
| R11 | Multiple simultaneous disruptions (Cercanías C-4 cancelled + EMT feed down + alert on Atocha) | Each handled independently; response still returns within SLA | All labels correct; p95 < 3 s |
| R12 | Alternative route calculation | Re-plan from the next stop excludes the cancelled trip | Excluded trip absent |
| R13 | Frequency-based leg (EMT/Metro) | Shown as "every N min", never as a precise scheduled time | Text check |
| R14 | DST change night | Departures around 02:00–03:00 correct | Matches expected fixture |
| R15 | Partial data: interurban stop 8_16825 | Scheduled only, "real-time not available" label | No live badge |

## 5. Performance tests (initial targets)
| Metric | Target |
|---|---|
| `/journeys` p95 (OTP, Madrid region, warm) | < 3 s at 10 req/s |
| `/stops/{id}/departures` p95 (cache hit) | < 300 ms at 50 req/s |
| Renfe feed ingestion cycle | < 2 s per poll |
| Full static import (all six feeds) | < 15 min on dev machine [to measure] |
| OTP graph build | Record time and heap; target ≤ 8 GB heap [to measure] |
| Nearest stops PostGIS query | < 50 ms p95 |

## 6. Quality metrics tracked continuously
- RT ↔ static trip-match rate per source (alert < 90 %).
- Feed age per source (alert when STALE).
- % of departures shown as Live, Scheduled or Unavailable per operator (product honesty metric).
- Prediction MAE and % within ±2 min (only after ≥ 500 matched samples per operator and horizon).
- Upstream error rate and breaker openings.

## 7. Exit criteria per phase
- **Phase 2:** all GTFS unit and integration tests pass; validator reports for all feeds are archived; OTP builds and answers the Parla → Atocha fixture query.
- **Phase 3:** scenarios R1–R9, R13–R15 pass; 7-day freshness calibration completed.
- **Phase 6:** R10–R12 pass; notification delivery verified on real devices.
