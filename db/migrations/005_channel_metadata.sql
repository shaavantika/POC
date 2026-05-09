-- Add channel metadata fields for display/ops.
ALTER TABLE channel_mrss_sources
    ADD COLUMN IF NOT EXISTS channel_name TEXT,
    ADD COLUMN IF NOT EXISTS country TEXT;

-- Keep values clean for new/updated rows.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'channel_mrss_sources_channel_name_not_blank'
    ) THEN
        ALTER TABLE channel_mrss_sources
            ADD CONSTRAINT channel_mrss_sources_channel_name_not_blank
            CHECK (channel_name IS NULL OR length(trim(channel_name)) > 0);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'channel_mrss_sources_country_not_blank'
    ) THEN
        ALTER TABLE channel_mrss_sources
            ADD CONSTRAINT channel_mrss_sources_country_not_blank
            CHECK (country IS NULL OR length(trim(country)) > 0);
    END IF;
END $$;
