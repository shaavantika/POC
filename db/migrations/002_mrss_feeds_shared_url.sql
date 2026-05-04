-- One row per distinct MRSS URL: shared fetch state so multiple channels can use the same feed
-- without duplicate polling. HTTP validators (etag / last_modified) support conditional GET.

CREATE TABLE mrss_feeds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Unique feed endpoint; several channel_mrss_sources rows may reference the same id.
    url TEXT NOT NULL,

    -- Polling: how often the fetcher may request this URL (seconds).
    fetch_interval_seconds INTEGER NOT NULL DEFAULT 900,
    CONSTRAINT mrss_feeds_fetch_interval_positive CHECK (fetch_interval_seconds > 0),

    -- Pause ingestion for this URL without deleting channel mappings.
    enabled BOOLEAN NOT NULL DEFAULT true,

    -- HTTP caching / conditional requests (persist across polls).
    etag TEXT NULL,
    last_modified TEXT NULL,

    -- Fetch bookkeeping (same URL fetched once; all linked channels reuse the outcome).
    last_fetch_at TIMESTAMPTZ NULL,
    last_success_at TIMESTAMPTZ NULL,
    last_http_status SMALLINT NULL,
    last_error TEXT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT mrss_feeds_url_key UNIQUE (url),
    CONSTRAINT mrss_feeds_url_not_blank CHECK (length(trim(url)) > 0)
);

COMMENT ON TABLE mrss_feeds IS 'Distinct MRSS feed URLs with shared HTTP/poll state (one fetch serves all channels pointing here).';
COMMENT ON COLUMN mrss_feeds.etag IS 'Last If-None-Match / ETag value from the origin for conditional GET.';
COMMENT ON COLUMN mrss_feeds.last_modified IS 'Last Last-Modified header value stored for If-Modified-Since.';
COMMENT ON COLUMN mrss_feeds.last_fetch_at IS 'Last attempt time (success or failure).';
COMMENT ON COLUMN mrss_feeds.last_success_at IS 'Last time the feed body was retrieved and parsed successfully.';

CREATE INDEX idx_mrss_feeds_enabled_next_fetch ON mrss_feeds (enabled)
    WHERE enabled = true;

CREATE TRIGGER trg_mrss_feeds_updated_at
    BEFORE UPDATE ON mrss_feeds
    FOR EACH ROW
    EXECUTE PROCEDURE set_updated_at();

-- Link channels to feeds; drop duplicated URL column from channel rows.

ALTER TABLE channel_mrss_sources
    ADD COLUMN mrss_feed_id UUID REFERENCES mrss_feeds (id);

INSERT INTO mrss_feeds (url)
SELECT DISTINCT trim(mrss_url)
FROM channel_mrss_sources;

UPDATE channel_mrss_sources AS c
SET mrss_feed_id = f.id
FROM mrss_feeds AS f
WHERE f.url = trim(c.mrss_url);

ALTER TABLE channel_mrss_sources
    ALTER COLUMN mrss_feed_id SET NOT NULL;

DROP INDEX IF EXISTS idx_channel_mrss_sources_mrss_url;

ALTER TABLE channel_mrss_sources
    DROP COLUMN mrss_url;

CREATE INDEX idx_channel_mrss_sources_mrss_feed_id ON channel_mrss_sources (mrss_feed_id);

COMMENT ON COLUMN channel_mrss_sources.mrss_feed_id IS 'FK to mrss_feeds; many channels may share one feed URL.';
