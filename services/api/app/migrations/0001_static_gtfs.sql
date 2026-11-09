-- Phase 2: feed-versioned static GTFS (see docs/DATABASE_DESIGN.md).
-- Static rows always carry feed_version_id. A new import is loaded inactive and then
-- switched on atomically, so readers never see a half-imported feed.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE operator (
    id               text PRIMARY KEY,          -- source key, e.g. 'interurban'
    name             text NOT NULL,
    mode             text NOT NULL,
    attribution_text text NOT NULL,
    licence_url      text NOT NULL
);

CREATE TABLE feed_version (
    id                  serial PRIMARY KEY,
    source              text NOT NULL REFERENCES operator(id),
    downloaded_at       timestamptz NOT NULL,
    imported_at         timestamptz,
    sha256              text NOT NULL,
    file_path           text NOT NULL,
    feed_version_label  text,
    service_start       date,
    service_end         date,
    validation_status   text NOT NULL DEFAULT 'not_run'
        CHECK (validation_status IN ('not_run', 'valid', 'warnings', 'errors', 'failed')),
    validation_errors   integer,
    validation_warnings integer,
    validation_report   text,
    row_counts          jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_active           boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX feed_version_one_active ON feed_version (source) WHERE is_active;

CREATE TABLE stop (
    feed_version_id     integer NOT NULL REFERENCES feed_version(id) ON DELETE CASCADE,
    native_id           text NOT NULL,
    id                  text NOT NULL,             -- global id, e.g. 'crtm:par_8_16825'
    root_id             text NOT NULL,             -- parent station's global id, or id
    code                text,
    name                text NOT NULL,
    search_name         text NOT NULL,             -- lower case, accents removed
    description         text,
    lat                 double precision,
    lon                 double precision,
    geom                geography(Point, 4326) GENERATED ALWAYS AS (
        CASE WHEN lat IS NOT NULL AND lon IS NOT NULL
             THEN ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography END
    ) STORED,
    location_type       smallint NOT NULL DEFAULT 0,
    parent_id           text,
    zone_id             text,
    wheelchair_boarding smallint,
    PRIMARY KEY (feed_version_id, native_id)
);
CREATE INDEX stop_id_idx ON stop (id);
CREATE INDEX stop_root_idx ON stop (root_id);
CREATE INDEX stop_geom_idx ON stop USING gist (geom);
CREATE INDEX stop_search_trgm_idx ON stop USING gin (search_name gin_trgm_ops);

CREATE TABLE route (
    feed_version_id integer NOT NULL REFERENCES feed_version(id) ON DELETE CASCADE,
    native_id       text NOT NULL,
    agency_id       text,
    short_name      text,
    long_name       text,
    route_type      integer NOT NULL,
    color           text,
    text_color      text,
    PRIMARY KEY (feed_version_id, native_id)
);

CREATE TABLE trip (
    feed_version_id       integer NOT NULL REFERENCES feed_version(id) ON DELETE CASCADE,
    native_id             text NOT NULL,
    route_id              text NOT NULL,
    service_id            text NOT NULL,
    headsign              text,
    short_name            text,
    direction_id          smallint,
    shape_id              text,
    wheelchair_accessible smallint,
    last_stop_sequence    integer,              -- filled after import; hides arrivals at the terminus
    is_frequency_based    boolean NOT NULL DEFAULT false,
    PRIMARY KEY (feed_version_id, native_id)
);
CREATE INDEX trip_service_idx ON trip (feed_version_id, service_id);

-- One partition per feed version: dropping an old version is a cheap DROP TABLE.
CREATE TABLE stop_time (
    feed_version_id integer NOT NULL,
    trip_id         text NOT NULL,
    stop_sequence   integer NOT NULL,
    stop_id         text NOT NULL,              -- native stop id
    arrival_s       integer,                    -- seconds after service-day midnight; may exceed 86400
    departure_s     integer,
    pickup_type     smallint,
    drop_off_type   smallint
) PARTITION BY LIST (feed_version_id);

CREATE TABLE frequency (
    feed_version_id integer NOT NULL REFERENCES feed_version(id) ON DELETE CASCADE,
    trip_id         text NOT NULL,
    start_s         integer NOT NULL,
    end_s           integer NOT NULL,
    headway_s       integer NOT NULL,
    exact_times     boolean NOT NULL DEFAULT false
);
CREATE INDEX frequency_trip_idx ON frequency (feed_version_id, trip_id);

CREATE TABLE service_calendar (
    feed_version_id integer NOT NULL REFERENCES feed_version(id) ON DELETE CASCADE,
    service_id      text NOT NULL,
    days            boolean[] NOT NULL,         -- Monday..Sunday (ISO order)
    start_date      date NOT NULL,
    end_date        date NOT NULL,
    PRIMARY KEY (feed_version_id, service_id)
);

CREATE TABLE service_calendar_date (
    feed_version_id integer NOT NULL REFERENCES feed_version(id) ON DELETE CASCADE,
    service_id      text NOT NULL,
    date            date NOT NULL,
    exception_type  smallint NOT NULL,          -- 1 added, 2 removed
    PRIMARY KEY (feed_version_id, service_id, date)
);

-- Derived at import: which routes serve each stop (for search results and stop boards).
CREATE TABLE stop_route (
    feed_version_id integer NOT NULL REFERENCES feed_version(id) ON DELETE CASCADE,
    stop_native_id  text NOT NULL,
    root_id         text NOT NULL,
    route_id        text NOT NULL,
    PRIMARY KEY (feed_version_id, stop_native_id, route_id)
);
CREATE INDEX stop_route_root_idx ON stop_route (root_id);
