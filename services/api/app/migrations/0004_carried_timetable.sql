-- A timetable kept in use after its own calendar ran out (app/ingest/carry.py): the last day
-- of the feed's own calendar. NULL for a feed used as published.
ALTER TABLE feed_version ADD COLUMN carried_from date;
