-- Phase 3: one row per real-time poll, for monitoring and freshness calibration
-- (RELIABILITY_STRATEGY.md §3: FRESH = p95 update interval x 2, DELAYED = p99 x 3).
CREATE TABLE adapter_health (
    id           bigserial PRIMARY KEY,
    source       text        NOT NULL,
    checked_at   timestamptz NOT NULL DEFAULT now(),
    ok           boolean     NOT NULL,
    latency_ms   real,
    source_ts    timestamptz,          -- the feed's own timestamp (GTFS-RT header)
    feed_age_s   real,                 -- checked_at - source_ts
    entity_count integer,
    match_rate   real,                 -- share of RT trips found in the active static feed
    error        text
);
CREATE INDEX adapter_health_source_time ON adapter_health (source, checked_at);
