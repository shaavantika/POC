-- Channel MRSS feed registration: one row per channel service + MRSS URL.
-- Requires PostgreSQL 13+ for gen_random_uuid(); on older versions use uuid-ossp.

CREATE TABLE channel_mrss_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- External channel identifier from your channel service (must be unique per deployment).
    channel_service_id TEXT NOT NULL,

    -- MRSS feed endpoint (HTTPS recommended).
    mrss_url TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT channel_mrss_sources_channel_service_id_key UNIQUE (channel_service_id),
    CONSTRAINT channel_mrss_sources_mrss_url_not_blank CHECK (length(trim(mrss_url)) > 0),
    CONSTRAINT channel_mrss_sources_channel_service_id_not_blank CHECK (length(trim(channel_service_id)) > 0)
);

COMMENT ON TABLE channel_mrss_sources IS 'Maps a channel service id to its MRSS XML feed URL for ingestion.';
COMMENT ON COLUMN channel_mrss_sources.channel_service_id IS 'Stable id from the channel/catalog service.';
COMMENT ON COLUMN channel_mrss_sources.mrss_url IS 'HTTP(S) URL returning MRSS XML for this channel.';

CREATE INDEX idx_channel_mrss_sources_mrss_url ON channel_mrss_sources (mrss_url);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_channel_mrss_sources_updated_at
    BEFORE UPDATE ON channel_mrss_sources
    FOR EACH ROW
    EXECUTE PROCEDURE set_updated_at();
