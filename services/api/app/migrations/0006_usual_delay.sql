-- How late Cercanías trains usually are (app/realtime/usual.py), recomputed daily by the
-- worker from observed_arrival. `stop_id` '*' = the whole line; `band` '*' = any time.
CREATE TABLE usual_delay (
    source      text    NOT NULL,
    line        text    NOT NULL,
    stop_id     text    NOT NULL,   -- native stop id
    band        text    NOT NULL,   -- weekday_morning, ..., weekend
    n           integer NOT NULL,
    days        integer NOT NULL,
    median_s    real    NOT NULL,   -- early arrivals counted as 0
    often_s     real    NOT NULL,   -- 80th percentile
    first_day   date    NOT NULL,
    last_day    date    NOT NULL,
    PRIMARY KEY (source, line, stop_id, band)
);
