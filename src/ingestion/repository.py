from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable

from psycopg import Connection
from psycopg.types.json import Jsonb

from src.ingestion.models import AssetRecord


def upsert_assets(
    conn: Connection,
    mrss_feed_id: str,
    assets: Iterable[AssetRecord],
) -> int:
    now = datetime.now(timezone.utc)
    rows = list(assets)
    if not rows:
        return 0

    sql = """
        INSERT INTO mrss_assets (
            mrss_feed_id, asset_id, asset_type,
            series_id, season_id, season_number, episode_number,
            title, description, rating, genre, tms_id,
            thumbnail_url, subtitle_url,
            valid_from, valid_to, duration_ms,
            raw_payload, last_seen_at, active
        ) VALUES (
            %(mrss_feed_id)s, %(asset_id)s, %(asset_type)s,
            %(series_id)s, %(season_id)s, %(season_number)s, %(episode_number)s,
            %(title)s, %(description)s, %(rating)s, %(genre)s, %(tms_id)s,
            %(thumbnail_url)s, %(subtitle_url)s,
            %(valid_from)s, %(valid_to)s, %(duration_ms)s,
            %(raw_payload)s, %(last_seen_at)s, true
        )
        ON CONFLICT (mrss_feed_id, asset_id) DO UPDATE SET
            asset_type = EXCLUDED.asset_type,
            series_id = EXCLUDED.series_id,
            season_id = EXCLUDED.season_id,
            season_number = EXCLUDED.season_number,
            episode_number = EXCLUDED.episode_number,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            rating = EXCLUDED.rating,
            genre = EXCLUDED.genre,
            tms_id = EXCLUDED.tms_id,
            thumbnail_url = EXCLUDED.thumbnail_url,
            subtitle_url = EXCLUDED.subtitle_url,
            valid_from = EXCLUDED.valid_from,
            valid_to = EXCLUDED.valid_to,
            duration_ms = EXCLUDED.duration_ms,
            raw_payload = EXCLUDED.raw_payload,
            last_seen_at = EXCLUDED.last_seen_at,
            active = true
    """

    with conn.cursor() as cur:
        for asset in rows:
            cur.execute(
                sql,
                {
                    "mrss_feed_id": mrss_feed_id,
                    "asset_id": asset.asset_id,
                    "asset_type": asset.asset_type,
                    "series_id": asset.series_id,
                    "season_id": asset.season_id,
                    "season_number": asset.season_number,
                    "episode_number": asset.episode_number,
                    "title": asset.title,
                    "description": asset.description,
                    "rating": asset.rating,
                    "genre": asset.genre,
                    "tms_id": asset.tms_id,
                    "thumbnail_url": asset.thumbnail_url,
                    "subtitle_url": asset.subtitle_url,
                    "valid_from": asset.valid_from,
                    "valid_to": asset.valid_to,
                    "duration_ms": asset.duration_ms,
                    "raw_payload": Jsonb(asset.raw_payload),
                    "last_seen_at": now,
                },
            )

        # Optional cleanup marker: anything not seen in this ingest stays active for now.
        # We can add "deactivate missing assets" behavior once snapshot semantics are confirmed.
    conn.commit()
    return len(rows)

