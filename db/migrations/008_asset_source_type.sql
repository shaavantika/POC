-- Generalizes mrss_feeds to support non-MRSS catalog sources (CSV/XLSX uploads),
-- reusing the same shared-source / channel-mapping / asset model as MRSS feeds.
-- Depends on: 003_assets_and_schedule_tables.sql

ALTER TABLE mrss_feeds
    ALTER COLUMN url DROP NOT NULL;

ALTER TABLE mrss_feeds
    ADD COLUMN source_type TEXT NOT NULL DEFAULT 'mrss';

ALTER TABLE mrss_feeds
    ADD CONSTRAINT mrss_feeds_source_type_check
        CHECK (source_type IN ('mrss', 'csv'));

COMMENT ON COLUMN mrss_feeds.source_type IS 'mrss (polled XML URL) or csv (uploaded CSV/XLSX catalog snapshot).';
COMMENT ON COLUMN mrss_feeds.url IS 'Feed endpoint URL; NULL for upload-based csv sources.';
