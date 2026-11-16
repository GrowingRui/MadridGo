-- Lines a feed lists without any trips, and the stops they serve according to the
-- operator's network map (app/ingest/untimed.py). MadridGo cannot show or plan them, so
-- boards and journeys at these stops say so.
CREATE TABLE untimed_route_stop (
    feed_version_id integer NOT NULL REFERENCES feed_version(id) ON DELETE CASCADE,
    route_id        text NOT NULL,
    stop_native_id  text NOT NULL,
    root_id         text NOT NULL,
    PRIMARY KEY (feed_version_id, route_id, stop_native_id)
);
CREATE INDEX untimed_route_stop_root_idx ON untimed_route_stop (root_id);
