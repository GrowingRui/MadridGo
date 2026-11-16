-- Predictions made while the train still stood at its first station (app/realtime/accuracy.py).
-- Renfe reports delay 0 until such a train leaves; on 2026-11-15/16 they came ~3.5 min later
-- than shown, so the app labels them "Not departed yet" and they are reported apart.
-- Rows before 2026-11-16 were not marked and stay false.
ALTER TABLE prediction_sample ADD COLUMN not_departed boolean NOT NULL DEFAULT false;

-- As in 0003, with predictions for trains not yet departed as kind 'not_departed' instead
-- of 'prediction' (accuracy_daily keeps them under that kind too).
CREATE OR REPLACE FUNCTION accuracy_metrics(first_day date, last_day date)
RETURNS TABLE (source text, line text, kind text, horizon_min smallint, estimated boolean,
               n integer, mae_s real, median_abs_s real, p90_abs_s real, bias_s real,
               pct_1m real, pct_2m real, pct_5m real)
LANGUAGE sql STABLE AS $$
WITH matched AS (
    SELECT p.source, coalesce(p.line, '?') AS line,
           CASE WHEN p.not_departed THEN 'not_departed' ELSE 'prediction' END AS kind,
           p.horizon_min, p.estimated AND NOT p.not_departed AS estimated,
           extract(epoch FROM o.observed_at - p.predicted_at)::float8 AS err
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
