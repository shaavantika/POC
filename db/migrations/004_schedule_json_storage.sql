-- Store generated schedule JSON payload per run for downloads/audit.

ALTER TABLE channel_schedule_runs
    ADD COLUMN IF NOT EXISTS schedule_json JSONB NULL;

COMMENT ON COLUMN channel_schedule_runs.schedule_json
IS 'Serialized schedule payload for this run, used for download/audit.';
