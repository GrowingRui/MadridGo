# Database Design

**Status:** Phase 0 proposal, 2026-11-09. The schema is deliberately minimal. Entities from the spec that are not justified yet are listed in §5 with the reason they are deferred.

Engine: PostgreSQL 16+ with PostGIS 3.x. Times are stored as `timestamptz` (UTC); service-day times as GTFS seconds-since-noon-minus-12h integers; time zone `Europe/Madrid`.

## 1. Design choices
- **Feed-versioned static data.** Each GTFS import is a `feed_version`. Static tables reference it, so a new import can be validated and switched atomically (blue/green), and old versions can be dropped.
- **Global IDs:** `{source}:{native_id}`. Native IDs are kept verbatim for traceability.
- **OTP owns routing data.** PostGIS keeps only what the API needs directly: stops, routes, patterns for display, and scheduled departures for stop boards. The full `stop_times` is imported too (about 4.8 M rows across feeds, see DATA_SOURCE_ANALYSIS.md §2.1), which is manageable in PostgreSQL.
- **Real-time "latest state" lives in Redis.** PostgreSQL stores **samples** for accuracy measurement and an audit trail, not every poll.

## 2. Entity-relationship diagram

```mermaid
erDiagram
  OPERATOR ||--o{ ROUTE : runs
  FEED_VERSION ||--o{ STOP : contains
  FEED_VERSION ||--o{ ROUTE : contains
  FEED_VERSION ||--o{ TRIP : contains
  FEED_VERSION ||--o{ SERVICE_CALENDAR : contains
  ROUTE ||--o{ TRIP : has
  TRIP ||--o{ STOP_TIME : has
  TRIP ||--o{ FREQUENCY : "may have"
  STOP ||--o{ STOP_TIME : at
  STOP }o--o| STOP : "parent_station"
  STOP ||--o{ STOP_MAPPING : "equivalent to"
  REALTIME_OBSERVATION }o--|| STOP : at
  VEHICLE_POSITION }o--o| TRIP : serving
  SERVICE_ALERT ||--o{ ALERT_ENTITY : affects
  TRANSFER_RULE }o--|| STOP : from
  TRANSFER_RULE }o--|| STOP : to
```

## 3. Tables

### Static (versioned)
| Table | Key columns | Notes |
|---|---|---|
| `operator` | `id`, `name`, `mode`, `attribution_text`, `licence_url` | Seeded: CRTM-Metro, CRTM-ML, Renfe Cercanías, EMT, CRTM-Interurban, CRTM-Urban |
| `feed_version` | `id`, `source`, `downloaded_at`, `sha256`, `feed_version_label`, `service_start`, `service_end`, `validation_status`, `is_active` | `service_end` drives expiry alarms |
| `stop` | `id` (global), `feed_version_id`, `native_id`, `code`, `name`, `geom geography(Point,4326)`, `location_type`, `parent_id`, `wheelchair_boarding`, `operator_id` | Station = `stop` with `location_type=1` (no separate Station table) |
| `route` | `id`, `feed_version_id`, `operator_id`, `short_name`, `long_name`, `route_type`, `color`, `text_color` | |
| `trip` | `id`, `feed_version_id`, `route_id`, `service_id`, `headsign`, `direction_id`, `shape_id` | |
| `stop_time` | `trip_id`, `stop_sequence`, `stop_id`, `arrival_s`, `departure_s` | Partition by `feed_version_id` |
| `frequency` | `trip_id`, `start_s`, `end_s`, `headway_s`, `exact_times` | Needed for EMT and Metro |
| `service_calendar` | `service_id`, `feed_version_id`, weekday flags, `start_date`, `end_date` | Plus `service_calendar_date` for exceptions |
| `shape` | `id`, `geom geography(LineString)` | Map rendering |
| `stop_mapping` | `stop_a`, `stop_b`, `relation` (`same_place`, `interchange`), `walk_s`, `verified_by` | Links widget IDs (`8_16825`) ↔ GTFS (`crtm:par_8_16825`), Renfe ↔ CRTM Cercanías, EMT GTFS ↔ EMT API |
| `transfer_rule` | `from_stop`, `to_stop`, `min_change_s`, `source` (`osm`, `manual`) | Curated station change times |

### Real-time and monitoring
| Table | Key columns | Notes |
|---|---|---|
| `realtime_observation` | `id`, `source`, `operator_id`, `source_record_id`, `trip_ref`, `vehicle_ref`, `stop_id`, `scheduled_at`, `predicted_at`, `actual_at`, `delay_s`, `classification`, `source_ts`, `retrieved_at` | **Sampled**: prediction horizons for accuracy (RELIABILITY_STRATEGY.md §4). Partition monthly; retention 90 days |
| `vehicle_position` | `source`, `vehicle_ref`, `trip_ref`, `geom`, `bearing`, `current_status`, `stop_id`, `source_ts`, `retrieved_at` | Latest in Redis; history only sampled for ground truth |
| `service_alert` | `id`, `source`, `source_alert_id`, `header`, `description` (jsonb i18n), `cause`, `effect`, `active_from`, `active_to`, `source_ts`, `retrieved_at` | |
| `alert_entity` | `alert_id`, `route_id`, `stop_id`, `trip_ref` | |
| `adapter_health` | `source`, `checked_at`, `ok`, `latency_ms`, `feed_age_s`, `entity_count`, `match_rate`, `error` | Monitoring history |
| `accuracy_metric` | `operator_id`, `route_id?`, `horizon_min`, `period`, `n`, `mae_s`, `p90_s`, `bias_s`, `pct_1m`, `pct_2m`, `pct_5m` | Aggregates retained long-term |

### Users (Phase 6, only if push notifications ship)
| Table | Notes |
|---|---|
| `device` | Anonymous device id, Expo push token, locale, created_at. **No email or name** |
| `journey_monitor` | `device_id`, serialized journey legs, active window, notification preferences |
| `notification` | `device_id`, `monitor_id`, type, sent_at, payload hash |

## 4. Indexes
- `stop`: GiST on `geom` (nearby-stop queries); btree `(feed_version_id, native_id)`; trigram on `name` (`pg_trgm`) for search.
- `stop_time`: btree `(stop_id, departure_s)` and `(trip_id, stop_sequence)`.
- `realtime_observation`: btree `(stop_id, predicted_at)`, `(trip_ref, stop_id, retrieved_at)`; BRIN on `retrieved_at` (append-only time series).
- `vehicle_position`: GiST `geom`, BRIN `source_ts`.
- `service_alert`: btree `(active_from, active_to)`.
- `feed_version`: partial unique index `(source) WHERE is_active`.

## 5. Spec entities deferred or merged
| Entity | Decision |
|---|---|
| Station | Merged into `stop` (`location_type=1`), as in GTFS |
| TransportMode | Enum column (`route_type`), not a table |
| Vehicle | No stable vehicle registry across sources; `vehicle_ref` on observations suffices |
| Journey / JourneyLeg | Not persisted; OTP computes on demand. Only `journey_monitor` stores a serialized snapshot (Phase 6) |
| Transfer | Becomes `transfer_rule` (curated) plus OTP's computed transfers |
| User | Replaced by anonymous `device` (GDPR minimization); full accounts post-MVP |
| Favorite | On-device in MVP |

## 6. Legal and retention constraints
- EMT terms require deleting received data if the agreement ends. EMT-derived rows carry `source` so they can be purged.
- CRTM licence requires keeping update and licence metadata, which `feed_version` stores.
- No personal data is stored in MVP. Phase 6 device tokens are deleted on monitor removal or after 90 days inactive.
