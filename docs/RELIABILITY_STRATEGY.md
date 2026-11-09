# Reliability Strategy

**Status:** Phase 0, 2026-11-09. Numeric thresholds are **initial proposals**. They must be calibrated against measured source behaviour before launch.

## 1. Principles
1. **Provenance over presentation:** every time shown to a user can be traced to a source record.
2. **Never upgrade certainty:** a scheduled time is never displayed as live; a stale live value is never displayed as fresh; a guessed classification is never displayed as fact.
3. **Degrade visibly:** when data fails, the UI says so and falls back to the next most reliable layer (live → scheduled → frequency estimate → unavailable).
4. **Measure before claiming:** accuracy figures are published only when enough ground truth exists.

## 2. Data provenance model
Every real-time observation stored or served carries the following fields:

| Field | Meaning | Example (Renfe) |
|---|---|---|
| `operator` | Operator code | `RENFE_CERCANIAS` |
| `source` | Adapter or feed | `renfe_gtfsrt_trip_updates` |
| `source_record_id` | Entity id in the feed | `TUUPDATE_3012L23547C1` |
| `trip_id` / `vehicle_id` | Service and vehicle | `3012L23547C1` / `23547` |
| `stop_id` | Normalized stop id | `renfe:51112` |
| `scheduled_time` | From static GTFS, if resolvable | – |
| `predicted_time` | From feed | `1794232140` |
| `actual_time` | Only if the feed states arrival or departure happened | – |
| `delay_s` | From feed or computed (predicted − scheduled) | `0` |
| `source_timestamp` | **Time the source generated or observed the data** (GTFS-RT header, entity or vehicle timestamp) | `1794229256` |
| `retrieved_at` | When MadridGo fetched it | server clock |
| `freshness` | Derived state (§3) | `FRESH` |
| `classification` | `LIVE`, `SCHEDULED`, `FREQUENCY_ESTIMATE`, `CANCELLED`, `UNKNOWN` | `LIVE` |

`source_timestamp` and `retrieved_at` are always stored separately. If a source provides no observation time (EMT [U]; the CRTM widget), `source_timestamp` is `null` and the UI shows "retrieved X s ago" with no claim about source age.

## 3. Freshness states
Age = `now − source_timestamp` (or `now − retrieved_at` when the source time is null, flagged as such).

| State | Meaning | UI |
|---|---|---|
| `FRESH` | Within the expected update interval | Live badge |
| `DELAYED_UPDATE` | Past the expected interval but still plausible | Live badge plus "updated 2 min ago" |
| `STALE` | Too old to rely on | Grey, "Outdated", fall back to schedule |
| `UNAVAILABLE` | No data or adapter failing | "Live data unavailable", show schedule |

Initial thresholds (configurable per adapter in `config/freshness.yaml`):

| Source | Measured or stated cadence | FRESH ≤ | DELAYED ≤ | STALE > | Basis |
|---|---|---|---|---|---|
| Renfe GTFS-RT | 20 s stated (alerts); header 16 s old observed | 60 s | 180 s | 180 s | [V] stated plus single observation |
| EMT API | [U] | 60 s | 180 s | 180 s | Placeholder; calibrate in Phase 3 |
| CRTM (if authorized) | Widget vehicle polling 15 s | 60 s | 180 s | 180 s | Placeholder |
| Static GTFS | Per feed | – | 7 days before calendar end: warning | Calendar ended: **block** | [V] Metro expiry |

**Calibration task (Phase 3):** poll each source for 7 days, record the distribution of `source_timestamp` deltas, and set FRESH = p95 interval × 2, DELAYED = p99 × 3.

## 4. Prediction accuracy framework
- **Ground truth:**
  - Cercanías: a vehicle position at a stop (`currentStatus = STOPPED_AT`, vehicle timestamp) gives an approximate actual arrival.
  - EMT: the last prediction before a bus disappears from a stop's list gives a weaker proxy [I].
  - Without ground truth there is **no** accuracy metric.
- **Storage:** for each (trip, stop), keep a sample of predictions at horizons of 30, 20, 10, 5 and 2 minutes, plus the observed actual time.
- **Metrics** per operator, line and horizon:
  - MAE.
  - Median and p90 absolute error.
  - Signed bias.
  - % within ±1 min, ±2 min and ±5 min.
- **Minimum sample** before publishing a metric: ≥ 500 matched predictions per operator and horizon over ≥ 7 days (initial proposal).
- Scheduled times are evaluated separately ("schedule adherence") and are **never** mixed into prediction accuracy.
- Retention must respect licence terms (EMT requires deletion on termination) and keep only what is needed: aggregated metrics are kept long-term, raw samples for 90 days (proposal).

## 5. Transfer reliability
OTP produces feasible connections using walking time plus `transferSlack` (default 2 min, https://docs.opentripplanner.org/en/latest/RouteRequest/). MadridGo adds a **post-routing reliability assessment** per transfer:

```
margin = next_departure(best estimate) − (arrival(best estimate) + walk_time + min_change_time[mode_pair, station])
```

| Label | Rule (initial) |
|---|---|
| **Comfortable** | margin ≥ 5 min |
| **Tight** | 2 ≤ margin < 5 min |
| **At risk** | 0 ≤ margin < 2 min, or the arriving leg is live and delayed so that margin < 2 min |
| **Not feasible** | margin < 0, or connecting trip cancelled |
| **Uncertain** | Either leg has no live data **and** the arriving mode's typical delay is unknown |

- **No percentages** until a statistical model is validated against observed delay distributions (Phase 6+).
- Margins widen for high-variance modes. For example, buses use +2 min until data shows otherwise.
- Headway-based legs (EMT, Metro) are shown as "wait up to N min", where N is the headway, not as a fixed connection.
- Station-specific change times (for example Atocha Cercanías ↔ Metro L1) are kept in a curated table, starting empty and filled from OSM walking paths plus manual verification.

## 6. Disruption handling
- Inputs: GTFS-RT Alerts (Renfe), EMT RSS, cancellations (`CANCELED`) and large delays in TripUpdates.
- **Journey impact:** a monitored journey is re-evaluated whenever a relevant feed updates. If any transfer becomes *At risk* or *Not feasible*, or a leg is cancelled, MadridGo re-queries OTP from the user's current position or next stop and offers alternatives.

## 7. Failure handling
| Mechanism | Design |
|---|---|
| Timeouts | Connect 3 s and read 5 s per upstream call (initial) |
| Retries | Max 2, exponential backoff (0.5 s, 1.5 s) with jitter; only on idempotent GETs and 5xx or timeouts |
| Rate limits | Honour 429 and `Retry-After`; per-source token bucket set below documented or agreed limits; shared cache so N users ≠ N upstream calls |
| Circuit breaker | Open after 5 consecutive failures or > 50 % failures in 60 s; half-open probe after 30 s; while open, serve cache labelled with its true age |
| Cache | Redis, keyed by source plus entity; value includes `source_timestamp` and `retrieved_at`; TTL = STALE threshold. Expired entries are **not** served as live |
| Graceful degradation | Live → Scheduled → Frequency estimate → Unavailable, always labelled |
| Monitoring | Per-adapter metrics: success rate, latency, feed age, entity counts, match rate (RT ↔ static). Alerts on feed age > STALE, match rate drop > 20 %, or GTFS expiry < 7 days |
| Logging | Structured JSON logs; no personal data |

## 8. Static data reliability
- Validate every GTFS import with the MobilityData GTFS validator (open source) before activation. Errors block activation; warnings are recorded.
- Keep the previous valid feed active until the new one passes validation (blue/green import).
- Block routing on a feed whose calendar has ended (the Metro case) unless a labelled, approved override exists.
