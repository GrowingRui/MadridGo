-- Phase 6: how accurate are live predictions? (RELIABILITY_STRATEGY.md §4)
-- The worker stores what MadridGo predicted for a stop at fixed horizons before the train
-- got there, and separately when the train was seen at the stop. Raw rows are kept 90 days;
-- the daily aggregates are kept long-term.

-- One prediction per (trip, service day, stop, horizon): the first poll at which the
-- predicted arrival was at most `horizon_min` minutes away.
CREATE TABLE prediction_sample (
    id            bigserial PRIMARY KEY,
    source        text        NOT NULL,          -- renfe_gtfsrt
    trip_id       text        NOT NULL,          -- native trip id
    service_date  date        NOT NULL,
    stop_index    integer     NOT NULL,          -- position along the trip, from 0
    stop_id       text        NOT NULL,          -- native stop id
    line          text,                          -- C4a, ...
    horizon_min   smallint    NOT NULL,
    made_at       timestamptz NOT NULL,          -- when MadridGo retrieved the prediction
    source_ts     timestamptz,                   -- the feed's own timestamp
    scheduled_at  timestamptz NOT NULL,
    predicted_at  timestamptz NOT NULL,
    delay_s       integer     NOT NULL,
    -- The trip's delay carried forward to a later stop ("Live · est." in the app), not a
    -- time the source gave for this stop.
    estimated     boolean     NOT NULL,
    -- Renfe's own time for the stop it names (only on that stop; may differ from
    -- scheduled + delay).
    source_predicted_at timestamptz,
    UNIQUE (source, trip_id, service_date, stop_index, horizon_min)
);
CREATE INDEX prediction_sample_made ON prediction_sample (made_at);

-- When the train was seen at the stop (the ground truth).
CREATE TABLE observed_arrival (
    source        text        NOT NULL,
    trip_id       text        NOT NULL,
    service_date  date        NOT NULL,
    stop_index    integer     NOT NULL,
    stop_id       text        NOT NULL,
    line          text,
    scheduled_at  timestamptz NOT NULL,
    observed_at   timestamptz NOT NULL,
    -- How the time was found and how far it can be off (see app/realtime/accuracy.py).
    method        text        NOT NULL,
    uncertainty_s integer     NOT NULL,
    PRIMARY KEY (source, trip_id, service_date, stop_index)
);
CREATE INDEX observed_arrival_time ON observed_arrival (observed_at);

-- Daily results per line and horizon, kept after the raw rows are deleted. `line` = '*'
-- is the whole operator. `kind`: 'prediction' (live times) or 'schedule' (timetable
-- adherence, horizon 0), never mixed.
CREATE TABLE accuracy_daily (
    day           date        NOT NULL,
    source        text        NOT NULL,
    line          text        NOT NULL,
    kind          text        NOT NULL,
    horizon_min   smallint    NOT NULL,
    estimated     boolean     NOT NULL,
    n             integer     NOT NULL,
    mae_s         real        NOT NULL,
    median_abs_s  real        NOT NULL,
    p90_abs_s     real        NOT NULL,
    bias_s        real        NOT NULL,          -- actual - predicted: > 0 means later than said
    pct_1m        real        NOT NULL,
    pct_2m        real        NOT NULL,
    pct_5m        real        NOT NULL,
    PRIMARY KEY (day, source, line, kind, horizon_min, estimated)
);

-- Results between two service dates: matched predictions ('prediction') and arrivals against
-- the timetable ('schedule', horizon 0), by line and horizon, plus the whole operator as
-- line '*'. Error = actual - predicted, in seconds. Used by `python -m app.realtime accuracy`
-- and for the daily rows above.
CREATE FUNCTION accuracy_metrics(first_day date, last_day date)
RETURNS TABLE (source text, line text, kind text, horizon_min smallint, estimated boolean,
               n integer, mae_s real, median_abs_s real, p90_abs_s real, bias_s real,
               pct_1m real, pct_2m real, pct_5m real)
LANGUAGE sql STABLE AS $$
WITH matched AS (
    SELECT p.source, coalesce(p.line, '?') AS line, 'prediction' AS kind, p.horizon_min,
           p.estimated, extract(epoch FROM o.observed_at - p.predicted_at)::float8 AS err
    FROM prediction_sample p
    JOIN observed_arrival o USING (source, trip_id, service_date, stop_index)
    WHERE p.service_date BETWEEN first_day AND last_day
    UNION ALL
    SELECT o.source, coalesce(o.line, '?'), 'schedule', 0::smallint, false,
           extract(epoch FROM o.observed_at - o.scheduled_at)::float8
    FROM observed_arrival o
    WHERE o.service_date BETWEEN first_day AND last_day
)
SELECT m.source, CASE WHEN grouping(m.line) = 1 THEN '*' ELSE m.line END, m.kind,
       m.horizon_min, m.estimated, count(*)::int,
       avg(abs(m.err))::real,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(m.err))::real,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY abs(m.err))::real,
       avg(m.err)::real,
       avg((abs(m.err) <= 60)::int)::real,
       avg((abs(m.err) <= 120)::int)::real,
       avg((abs(m.err) <= 300)::int)::real
FROM matched m
GROUP BY GROUPING SETS ((m.source, m.kind, m.horizon_min, m.estimated, m.line),
                        (m.source, m.kind, m.horizon_min, m.estimated))
$$;
