from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from psycopg import Connection
from psycopg.types.json import Jsonb

from src.scheduler.models import ScheduleAsset, ScheduleEntry, SegmentSpec


def get_feed_id_for_channel(conn: Connection, channel_service_id: str) -> str | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT mrss_feed_id
            FROM channel_mrss_sources
            WHERE channel_service_id = %s
            """,
            (channel_service_id,),
        )
        row = cur.fetchone()
    return str(row[0]) if row else None


def get_valid_assets(
    conn: Connection,
    mrss_feed_id: str,
    at_time: datetime,
) -> tuple[list[ScheduleAsset], list[ScheduleAsset]]:
    if at_time.tzinfo is None:
        at_time = at_time.replace(tzinfo=timezone.utc)

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                asset_id,
                asset_type,
                title,
                season_number,
                episode_number,
                duration_ms,
                valid_from,
                valid_to,
                raw_payload
            FROM mrss_assets
            WHERE mrss_feed_id = %s
              AND active = true
              AND duration_ms IS NOT NULL
            """,
            (mrss_feed_id,),
        )
        rows = cur.fetchall()

    episodes: list[ScheduleAsset] = []
    slates: list[ScheduleAsset] = []
    bumpers: list[ScheduleAsset] = []
    for row in rows:
        item = ScheduleAsset(
            asset_id=row[0],
            asset_type=row[1],
            title=row[2],
            season_number=row[3],
            episode_number=row[4],
            duration_ms=row[5],
            valid_from=row[6],
            valid_to=row[7],
            segments=[
                SegmentSpec(
                    order=int(seg.get("order", 0)),
                    duration_ms=int(seg.get("duration_ms", 0)),
                    insert_ad_break=bool(seg.get("insert_ad_break", False)),
                )
                for seg in (row[8] or {}).get("segments", [])
                if int(seg.get("duration_ms", 0)) > 0
            ],
        )
        if item.asset_type == "episode":
            episodes.append(item)
        elif item.asset_type == "slate":
            slates.append(item)
        elif item.asset_type == "bumper":
            bumpers.append(item)
    return episodes, slates, bumpers


def create_run(
    conn: Connection,
    channel_service_id: str,
    window_start: datetime,
    window_end: datetime,
    trigger_type: str,
    source_feed_id: str,
) -> UUID:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO channel_schedule_runs (
                channel_service_id,
                window_start,
                window_end,
                status,
                trigger_type,
                source_feed_id,
                started_at
            ) VALUES (%s, %s, %s, 'running', %s, %s, now())
            RETURNING id
            """,
            (
                channel_service_id,
                window_start,
                window_end,
                trigger_type,
                source_feed_id,
            ),
        )
        row = cur.fetchone()
    return row[0]


def mark_run_failed(conn: Connection, run_id: UUID, error_message: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE channel_schedule_runs
            SET status = 'failed',
                error_message = %s,
                completed_at = now()
            WHERE id = %s
            """,
            (error_message[:2000], run_id),
        )


def get_active_run_info(
    conn: Connection,
    channel_service_id: str,
) -> tuple[UUID, datetime, int] | None:
    """Return (run_id, actual_last_ends_at, entry_count) for the active run, or None.

    Uses MAX(ends_at) from entries rather than window_end so that a run whose
    engine truncated early is correctly detected as needing extension.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT r.id, MAX(e.ends_at), COUNT(e.sequence_no)
            FROM channel_schedule_runs r
            LEFT JOIN channel_schedule_entries e ON e.run_id = r.id
            WHERE r.channel_service_id = %s
              AND r.is_active = true
            GROUP BY r.id
            LIMIT 1
            """,
            (channel_service_id,),
        )
        row = cur.fetchone()
    if not row:
        return None
    run_id, last_ends_at, entry_count = row
    if last_ends_at is None:
        return None
    if last_ends_at.tzinfo is None:
        last_ends_at = last_ends_at.replace(tzinfo=timezone.utc)
    return run_id, last_ends_at, entry_count or 0


def get_max_sequence_no(conn: Connection, run_id: UUID) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT COALESCE(MAX(sequence_no), 0) FROM channel_schedule_entries WHERE run_id = %s",
            (run_id,),
        )
        row = cur.fetchone()
    return row[0] if row else 0


def append_entries_to_run(
    conn: Connection,
    run_id: UUID,
    channel_service_id: str,
    entries: list,
    new_window_end: datetime,
    new_entries_json: list[dict],
) -> None:
    with conn.cursor() as cur:
        for entry in entries:
            cur.execute(
                """
                INSERT INTO channel_schedule_entries (
                    run_id, channel_service_id,
                    sequence_no, starts_at, ends_at,
                    asset_id, asset_type, title,
                    season_number, episode_number, duration_ms
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                """,
                (
                    run_id,
                    channel_service_id,
                    entry.sequence_no,
                    entry.starts_at,
                    entry.ends_at,
                    entry.asset_id,
                    entry.asset_type,
                    entry.title,
                    entry.season_number,
                    entry.episode_number,
                    entry.duration_ms,
                ),
            )

        cur.execute(
            """
            UPDATE channel_schedule_runs
            SET window_end = %s,
                generated_entry_count = (
                    SELECT COUNT(*) FROM channel_schedule_entries WHERE run_id = %s
                ),
                schedule_json = jsonb_set(
                    schedule_json,
                    '{entries}',
                    (schedule_json->'entries') || %s::jsonb
                ),
                completed_at = now()
            WHERE id = %s
            """,
            (
                new_window_end,
                run_id,
                Jsonb(new_entries_json),
                run_id,
            ),
        )


def persist_entries_and_activate(
    conn: Connection,
    run_id: UUID,
    channel_service_id: str,
    entries: list[ScheduleEntry],
    schedule_json: dict,
) -> None:
    with conn.cursor() as cur:
        for entry in entries:
            cur.execute(
                """
                INSERT INTO channel_schedule_entries (
                    run_id, channel_service_id,
                    sequence_no, starts_at, ends_at,
                    asset_id, asset_type, title,
                    season_number, episode_number, duration_ms
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                """,
                (
                    run_id,
                    channel_service_id,
                    entry.sequence_no,
                    entry.starts_at,
                    entry.ends_at,
                    entry.asset_id,
                    entry.asset_type,
                    entry.title,
                    entry.season_number,
                    entry.episode_number,
                    entry.duration_ms,
                ),
            )

        cur.execute(
            """
            UPDATE channel_schedule_runs
            SET is_active = false
            WHERE channel_service_id = %s
              AND is_active = true
            """,
            (channel_service_id,),
        )

        cur.execute(
            """
            UPDATE channel_schedule_runs
            SET status = 'success',
                generated_entry_count = %s,
                schedule_json = %s,
                is_active = true,
                completed_at = now()
            WHERE id = %s
            """,
            (len(entries), Jsonb(schedule_json), run_id),
        )

