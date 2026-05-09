from __future__ import annotations

from psycopg import Connection


def upsert_feed(
    conn: Connection,
    mrss_url: str,
    fetch_interval_seconds: int,
    enabled: bool,
) -> tuple[str, str, int, bool]:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO mrss_feeds (url, fetch_interval_seconds, enabled)
            VALUES (%s, %s, %s)
            ON CONFLICT (url) DO UPDATE SET
                fetch_interval_seconds = EXCLUDED.fetch_interval_seconds,
                enabled = EXCLUDED.enabled
            RETURNING id, url, fetch_interval_seconds, enabled
            """,
            (mrss_url, fetch_interval_seconds, enabled),
        )
        row = cur.fetchone()
    return str(row[0]), row[1], row[2], row[3]


def upsert_channel_mapping(
    conn: Connection,
    channel_service_id: str,
    channel_name: str,
    country: str,
    mrss_feed_id: str,
) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO channel_mrss_sources (channel_service_id, channel_name, country, mrss_feed_id)
            VALUES (%s, %s, %s, %s::uuid)
            ON CONFLICT (channel_service_id) DO UPDATE SET
                channel_name = EXCLUDED.channel_name,
                country = EXCLUDED.country,
                mrss_feed_id = EXCLUDED.mrss_feed_id
            RETURNING channel_service_id
            """,
            (channel_service_id, channel_name, country, mrss_feed_id),
        )
        row = cur.fetchone()
    return row[0]


def list_feeds(conn: Connection) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                id,
                url,
                fetch_interval_seconds,
                enabled,
                last_fetch_at,
                last_http_status,
                last_error
            FROM mrss_feeds
            ORDER BY created_at DESC
            """
        )
        return cur.fetchall()


def list_due_mrss_feeds(conn: Connection, limit: int = 200) -> list[tuple[str, str]]:
    """
    Enabled feeds whose next poll time is in the past (per fetch_interval_seconds).

    A row is due if last_fetch_at is null (never fetched) or
    last_fetch_at + interval <= now().
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, url
            FROM mrss_feeds
            WHERE enabled = true
              AND (
                  last_fetch_at IS NULL
                  OR last_fetch_at <= now() - (fetch_interval_seconds * interval '1 second')
              )
            ORDER BY last_fetch_at NULLS FIRST
            LIMIT %s
            """,
            (limit,),
        )
        rows = cur.fetchall()
    return [(str(r[0]), str(r[1])) for r in rows]


def list_channels(conn: Connection) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                c.channel_service_id,
                c.channel_name,
                c.country,
                c.mrss_feed_id,
                f.url
            FROM channel_mrss_sources c
            JOIN mrss_feeds f ON f.id = c.mrss_feed_id
            ORDER BY c.channel_service_id
            """
        )
        return cur.fetchall()


def list_runs_for_channel(conn: Connection, channel_service_id: str, limit: int = 20) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, status, is_active, generated_entry_count, created_at, error_message
            FROM channel_schedule_runs
            WHERE channel_service_id = %s
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (channel_service_id, limit),
        )
        return cur.fetchall()


def active_schedule_entries_for_channel(conn: Connection, channel_service_id: str, limit: int = 200) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                e.sequence_no,
                e.starts_at,
                e.ends_at,
                e.asset_id,
                e.asset_type,
                e.title
            FROM channel_schedule_entries e
            JOIN channel_schedule_runs r ON r.id = e.run_id
            WHERE r.channel_service_id = %s
              AND r.is_active = true
            ORDER BY e.sequence_no
            LIMIT %s
            """,
            (channel_service_id, limit),
        )
        return cur.fetchall()


def list_assets_for_channel(conn: Connection, channel_service_id: str, limit: int = 200) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                a.asset_id,
                a.asset_type,
                a.title,
                a.season_number,
                a.episode_number,
                a.duration_ms,
                a.valid_from,
                a.valid_to,
                a.last_seen_at
            FROM mrss_assets a
            JOIN channel_mrss_sources c ON c.mrss_feed_id = a.mrss_feed_id
            WHERE c.channel_service_id = %s
              AND a.active = true
            ORDER BY
              a.asset_type,
              a.season_number NULLS LAST,
              a.episode_number NULLS LAST,
              a.asset_id
            LIMIT %s
            """,
            (channel_service_id, limit),
        )
        return cur.fetchall()


def mark_feed_fetch_success(
    conn: Connection,
    mrss_feed_id: str,
    http_status: int,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE mrss_feeds
            SET last_fetch_at = now(),
                last_success_at = now(),
                last_http_status = %s,
                last_error = NULL
            WHERE id = %s::uuid
            """,
            (http_status, mrss_feed_id),
        )


def mark_feed_fetch_failure(
    conn: Connection,
    mrss_feed_id: str,
    error_message: str,
    http_status: int | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE mrss_feeds
            SET last_fetch_at = now(),
                last_http_status = %s,
                last_error = %s
            WHERE id = %s::uuid
            """,
            (http_status, error_message[:2000], mrss_feed_id),
        )


def get_schedule_json_for_run(
    conn: Connection,
    channel_service_id: str,
    run_id: str,
) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT schedule_json
            FROM channel_schedule_runs
            WHERE channel_service_id = %s
              AND id = %s::uuid
            """,
            (channel_service_id, run_id),
        )
        row = cur.fetchone()
    return row[0] if row and row[0] else None


def get_active_schedule_json_for_channel(conn: Connection, channel_service_id: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT schedule_json
            FROM channel_schedule_runs
            WHERE channel_service_id = %s
              AND is_active = true
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (channel_service_id,),
        )
        row = cur.fetchone()
    return row[0] if row and row[0] else None

