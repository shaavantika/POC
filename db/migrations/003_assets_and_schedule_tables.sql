-- Core tables for normalized MRSS assets and generated schedules.
-- Depends on:
--   001_channel_mrss_sources.sql
--   002_mrss_feeds_shared_url.sql

CREATE TABLE mrss_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mrss_feed_id UUID NOT NULL REFERENCES mrss_feeds (id) ON DELETE CASCADE,

    asset_id TEXT NOT NULL,
    asset_type TEXT NOT NULL,

    series_id TEXT NULL,
    season_id TEXT NULL,
    season_number INTEGER NULL,
    episode_number INTEGER NULL,

    title TEXT NULL,
    description TEXT NULL,
    rating TEXT NULL,
    genre TEXT NULL,
    tms_id TEXT NULL,

    thumbnail_url TEXT NULL,
    subtitle_url TEXT NULL,

    valid_from TIMESTAMPTZ NULL,
    valid_to TIMESTAMPTZ NULL,

    -- Canonical playback duration used by schedule generator.
    duration_ms BIGINT NULL,

    -- Raw normalized JSON snapshot from parser for troubleshooting/replay.
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Last time this asset appeared in a successful feed parse.
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    active BOOLEAN NOT NULL DEFAULT true,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT mrss_assets_asset_type_check
        CHECK (asset_type IN ('episode', 'slate')),
    CONSTRAINT mrss_assets_asset_id_not_blank
        CHECK (length(trim(asset_id)) > 0),
    CONSTRAINT mrss_assets_duration_ms_positive
        CHECK (duration_ms IS NULL OR duration_ms > 0),
    CONSTRAINT mrss_assets_valid_window_check
        CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to > valid_from),
    CONSTRAINT mrss_assets_feed_asset_key
        UNIQUE (mrss_feed_id, asset_id)
);

COMMENT ON TABLE mrss_assets IS 'Normalized playable assets parsed from MRSS feeds.';
COMMENT ON COLUMN mrss_assets.asset_type IS 'episode or slate';
COMMENT ON COLUMN mrss_assets.last_seen_at IS 'Updated on each successful parse when asset is present in feed.';
COMMENT ON COLUMN mrss_assets.active IS 'Soft lifecycle flag; false when intentionally suppressed/retired.';

CREATE INDEX idx_mrss_assets_feed_type_order
    ON mrss_assets (mrss_feed_id, asset_type, season_number, episode_number, asset_id);
CREATE INDEX idx_mrss_assets_validity
    ON mrss_assets (valid_from, valid_to);
CREATE INDEX idx_mrss_assets_feed_last_seen
    ON mrss_assets (mrss_feed_id, last_seen_at DESC);
CREATE INDEX idx_mrss_assets_active
    ON mrss_assets (active)
    WHERE active = true;

CREATE TRIGGER trg_mrss_assets_updated_at
    BEFORE UPDATE ON mrss_assets
    FOR EACH ROW
    EXECUTE PROCEDURE set_updated_at();


CREATE TABLE channel_schedule_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_service_id TEXT NOT NULL REFERENCES channel_mrss_sources (channel_service_id) ON DELETE CASCADE,

    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT NULL,

    -- Indicates currently active run/version for the channel.
    is_active BOOLEAN NOT NULL DEFAULT false,

    -- Useful metadata for reproducibility/debugging.
    trigger_type TEXT NOT NULL DEFAULT 'auto',
    source_feed_id UUID NULL REFERENCES mrss_feeds (id),
    generated_entry_count INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT channel_schedule_runs_window_check
        CHECK (window_end > window_start),
    CONSTRAINT channel_schedule_runs_status_check
        CHECK (status IN ('pending', 'running', 'success', 'failed', 'cancelled')),
    CONSTRAINT channel_schedule_runs_trigger_type_check
        CHECK (trigger_type IN ('auto', 'manual', 'recovery'))
);

COMMENT ON TABLE channel_schedule_runs IS 'Generation attempts and version metadata for channel schedules.';
COMMENT ON COLUMN channel_schedule_runs.is_active IS 'At most one active successful run per channel.';

CREATE INDEX idx_channel_schedule_runs_channel_created
    ON channel_schedule_runs (channel_service_id, created_at DESC);
CREATE INDEX idx_channel_schedule_runs_status
    ON channel_schedule_runs (status, created_at DESC);
CREATE INDEX idx_channel_schedule_runs_active
    ON channel_schedule_runs (channel_service_id, is_active)
    WHERE is_active = true;

CREATE TRIGGER trg_channel_schedule_runs_updated_at
    BEFORE UPDATE ON channel_schedule_runs
    FOR EACH ROW
    EXECUTE PROCEDURE set_updated_at();


CREATE TABLE channel_schedule_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES channel_schedule_runs (id) ON DELETE CASCADE,
    channel_service_id TEXT NOT NULL REFERENCES channel_mrss_sources (channel_service_id) ON DELETE CASCADE,

    sequence_no INTEGER NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,

    asset_id TEXT NOT NULL,
    asset_type TEXT NOT NULL,
    title TEXT NULL,
    season_number INTEGER NULL,
    episode_number INTEGER NULL,
    duration_ms BIGINT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT channel_schedule_entries_time_check
        CHECK (ends_at > starts_at),
    CONSTRAINT channel_schedule_entries_asset_type_check
        CHECK (asset_type IN ('episode', 'slate')),
    CONSTRAINT channel_schedule_entries_duration_positive
        CHECK (duration_ms > 0),
    CONSTRAINT channel_schedule_entries_run_sequence_key
        UNIQUE (run_id, sequence_no)
);

COMMENT ON TABLE channel_schedule_entries IS 'Concrete timeline entries generated for a schedule run.';

CREATE INDEX idx_channel_schedule_entries_run_time
    ON channel_schedule_entries (run_id, starts_at);
CREATE INDEX idx_channel_schedule_entries_channel_time
    ON channel_schedule_entries (channel_service_id, starts_at);

