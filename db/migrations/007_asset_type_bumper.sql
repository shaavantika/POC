ALTER TABLE mrss_assets
    DROP CONSTRAINT mrss_assets_asset_type_check,
    ADD CONSTRAINT mrss_assets_asset_type_check
        CHECK (asset_type = ANY (ARRAY['episode'::text, 'slate'::text, 'bumper'::text]));
