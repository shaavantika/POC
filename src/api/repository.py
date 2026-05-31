from __future__ import annotations

from datetime import datetime, timedelta

from psycopg import Connection
from psycopg.types.json import Jsonb


def _shift_iso(iso_str: str | None, delta_ms: int) -> str | None:
    if not iso_str:
        return iso_str
    try:
        dt = datetime.fromisoformat(str(iso_str).replace("Z", "+00:00"))
        return (dt + timedelta(milliseconds=delta_ms)).isoformat()
    except (ValueError, TypeError):
        return iso_str


def _patch_schedule_json_delete(
    conn: Connection, run_id, deleted_seq: int, duration_ms: int
) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT schedule_json FROM channel_schedule_runs WHERE id = %s", (run_id,))
        row = cur.fetchone()
    if not row or not row[0]:
        return
    payload = dict(row[0])
    raw = payload.get("entries")
    if not isinstance(raw, list):
        return

    new_entries = []
    for e in raw:
        if not isinstance(e, dict):
            continue
        seq = e.get("sequence_no")
        if seq == deleted_seq:
            continue
        e = dict(e)
        if isinstance(seq, int) and seq > deleted_seq:
            e["sequence_no"] = seq - 1
            e["starts_at"] = _shift_iso(e.get("starts_at"), -duration_ms)
            e["ends_at"] = _shift_iso(e.get("ends_at"), -duration_ms)
        new_entries.append(e)

    payload["entries"] = new_entries
    payload["entry_count"] = len(new_entries)
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE channel_schedule_runs SET schedule_json = %s WHERE id = %s",
            (Jsonb(payload), run_id),
        )


def _patch_schedule_json_edit(
    conn: Connection,
    run_id,
    sequence_no: int,
    asset_id: str,
    asset_type: str,
    title: str | None,
    new_duration_ms: int,
    duration_diff_ms: int,
    cue_points_ms: list[int] | None = None,
    ad_breaks: list[dict] | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT schedule_json FROM channel_schedule_runs WHERE id = %s", (run_id,))
        row = cur.fetchone()
    if not row or not row[0]:
        return
    payload = dict(row[0])
    raw = payload.get("entries")
    if not isinstance(raw, list):
        return

    new_entries = []
    for e in raw:
        if not isinstance(e, dict):
            continue
        seq = e.get("sequence_no")
        e = dict(e)
        if seq == sequence_no:
            e["asset_id"] = asset_id
            e["asset_type"] = asset_type
            e["title"] = title
            e["duration_ms"] = new_duration_ms
            e["ends_at"] = _shift_iso(e.get("starts_at"), new_duration_ms)
            e["cue_points_ms"] = cue_points_ms if cue_points_ms is not None else []
            e["ad_breaks"] = ad_breaks if ad_breaks is not None else []
            e.pop("slate_plan", None)
            e.pop("cue_points_ms_csv", None)
        elif isinstance(seq, int) and seq > sequence_no and duration_diff_ms != 0:
            e["starts_at"] = _shift_iso(e.get("starts_at"), duration_diff_ms)
            e["ends_at"] = _shift_iso(e.get("ends_at"), duration_diff_ms)
        new_entries.append(e)

    payload["entries"] = new_entries
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE channel_schedule_runs SET schedule_json = %s WHERE id = %s",
            (Jsonb(payload), run_id),
        )


def _patch_schedule_json_insert(
    conn: Connection,
    run_id,
    after_seq: int,
    new_seq: int,
    starts_at,
    ends_at,
    asset_id: str,
    asset_type: str,
    title: str | None,
    duration_ms: int,
) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT schedule_json FROM channel_schedule_runs WHERE id = %s", (run_id,))
        row = cur.fetchone()
    if not row or not row[0]:
        return
    payload = dict(row[0])
    raw = payload.get("entries")
    if not isinstance(raw, list):
        return

    new_entries = []
    for e in raw:
        if not isinstance(e, dict):
            continue
        seq = e.get("sequence_no")
        e = dict(e)
        if isinstance(seq, int) and seq > after_seq:
            e["sequence_no"] = seq + 1
            e["starts_at"] = _shift_iso(e.get("starts_at"), duration_ms)
            e["ends_at"] = _shift_iso(e.get("ends_at"), duration_ms)
        new_entries.append(e)

    starts_iso = starts_at.isoformat() if hasattr(starts_at, "isoformat") else str(starts_at)
    ends_iso = ends_at.isoformat() if hasattr(ends_at, "isoformat") else str(ends_at)
    new_entries.append({
        "sequence_no": new_seq,
        "starts_at": starts_iso,
        "ends_at": ends_iso,
        "asset_id": asset_id,
        "asset_type": asset_type,
        "title": title,
        "duration_ms": duration_ms,
        "cue_points_ms": [],
        "cue_points_ms_csv": "",
        "slate_plan": [],
    })
    new_entries.sort(key=lambda e: e.get("sequence_no", 0))
    payload["entries"] = new_entries
    payload["entry_count"] = len(new_entries)
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE channel_schedule_runs SET schedule_json = %s WHERE id = %s",
            (Jsonb(payload), run_id),
        )


def insert_after_schedule_entry(
    conn: Connection,
    channel_service_id: str,
    after_sequence_no: int,
    asset_id: str,
    asset_type: str,
    title: str | None,
    duration_ms: int,
    season_number: int | None,
    episode_number: int | None,
) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT e.run_id, e.ends_at
            FROM channel_schedule_entries e
            JOIN channel_schedule_runs r ON r.id = e.run_id
            WHERE r.channel_service_id = %s AND r.is_active = true AND e.sequence_no = %s
            """,
            (channel_service_id, after_sequence_no),
        )
        row = cur.fetchone()
    if not row:
        return False
    run_id, new_starts_at = row
    new_ends_at = new_starts_at + timedelta(milliseconds=duration_ms)
    new_sequence_no = after_sequence_no + 1

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE channel_schedule_entries
            SET starts_at   = starts_at + (%s * interval '1 millisecond'),
                ends_at     = ends_at   + (%s * interval '1 millisecond'),
                sequence_no = sequence_no + 1
            WHERE run_id = %s AND sequence_no > %s
            """,
            (duration_ms, duration_ms, run_id, after_sequence_no),
        )
        cur.execute(
            """
            INSERT INTO channel_schedule_entries (
                run_id, channel_service_id, sequence_no,
                starts_at, ends_at,
                asset_id, asset_type, title,
                season_number, episode_number, duration_ms
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                run_id, channel_service_id, new_sequence_no,
                new_starts_at, new_ends_at,
                asset_id, asset_type, title,
                season_number, episode_number, duration_ms,
            ),
        )
    _patch_schedule_json_insert(
        conn, run_id, after_sequence_no, new_sequence_no,
        new_starts_at, new_ends_at,
        asset_id, asset_type, title, duration_ms,
    )
    return True


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


def active_schedule_entries_for_channel(conn: Connection, channel_service_id: str, limit: int = 5000) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                e.sequence_no,
                e.starts_at,
                e.ends_at,
                e.asset_id,
                e.asset_type,
                e.title,
                e.season_number,
                e.episode_number
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


def update_asset_type(
    conn: Connection,
    channel_service_id: str,
    asset_id: str,
    asset_type: str,
) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE mrss_assets a
            SET asset_type = %s
            FROM channel_mrss_sources c
            WHERE c.mrss_feed_id = a.mrss_feed_id
              AND c.channel_service_id = %s
              AND a.asset_id = %s
              AND a.active = true
            """,
            (asset_type, channel_service_id, asset_id),
        )
        return cur.rowcount > 0


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


def get_entry_starts_at(
    conn: Connection,
    channel_service_id: str,
    sequence_no: int,
):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT e.starts_at
            FROM channel_schedule_entries e
            JOIN channel_schedule_runs r ON r.id = e.run_id
            WHERE r.channel_service_id = %s
              AND r.is_active = true
              AND e.sequence_no = %s
            """,
            (channel_service_id, sequence_no),
        )
        row = cur.fetchone()
    return row[0] if row else None


def delete_active_schedule_entry(
    conn: Connection,
    channel_service_id: str,
    sequence_no: int,
) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT e.run_id, e.duration_ms
            FROM channel_schedule_entries e
            JOIN channel_schedule_runs r ON r.id = e.run_id
            WHERE r.channel_service_id = %s AND r.is_active = true AND e.sequence_no = %s
            """,
            (channel_service_id, sequence_no),
        )
        row = cur.fetchone()
    if not row:
        return False
    run_id, duration_ms = row[0], row[1]

    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM channel_schedule_entries WHERE run_id = %s AND sequence_no = %s",
            (run_id, sequence_no),
        )
        cur.execute(
            """
            UPDATE channel_schedule_entries
            SET starts_at   = starts_at - (%s * interval '1 millisecond'),
                ends_at     = ends_at   - (%s * interval '1 millisecond'),
                sequence_no = sequence_no - 1
            WHERE run_id = %s AND sequence_no > %s
            """,
            (duration_ms, duration_ms, run_id, sequence_no),
        )
    _patch_schedule_json_delete(conn, run_id, sequence_no, duration_ms)
    return True


def get_asset_for_channel(
    conn: Connection,
    channel_service_id: str,
    asset_id: str,
) -> tuple | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT a.asset_id, a.asset_type, a.title, a.duration_ms,
                   a.season_number, a.episode_number
            FROM mrss_assets a
            JOIN channel_mrss_sources c ON c.mrss_feed_id = a.mrss_feed_id
            WHERE c.channel_service_id = %s
              AND a.asset_id = %s
              AND a.active = true
            """,
            (channel_service_id, asset_id),
        )
        return cur.fetchone()


def update_active_schedule_entry_asset(
    conn: Connection,
    channel_service_id: str,
    sequence_no: int,
    asset_id: str,
    asset_type: str,
    title: str | None,
    duration_ms: int,
    cue_points_ms: list[int] | None = None,
    ad_breaks: list[dict] | None = None,
) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT e.run_id, e.duration_ms
            FROM channel_schedule_entries e
            JOIN channel_schedule_runs r ON r.id = e.run_id
            WHERE r.channel_service_id = %s AND r.is_active = true AND e.sequence_no = %s
            """,
            (channel_service_id, sequence_no),
        )
        row = cur.fetchone()
    if not row:
        return False
    run_id, old_duration_ms = row[0], row[1]
    duration_diff = duration_ms - old_duration_ms

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE channel_schedule_entries
            SET asset_id    = %s,
                asset_type  = %s,
                title       = %s,
                duration_ms = %s,
                ends_at     = starts_at + (%s * interval '1 millisecond')
            WHERE run_id = %s AND sequence_no = %s
            """,
            (asset_id, asset_type, title, duration_ms, duration_ms, run_id, sequence_no),
        )
        if duration_diff != 0:
            cur.execute(
                """
                UPDATE channel_schedule_entries
                SET starts_at = starts_at + (%s * interval '1 millisecond'),
                    ends_at   = ends_at   + (%s * interval '1 millisecond')
                WHERE run_id = %s AND sequence_no > %s
                """,
                (duration_diff, duration_diff, run_id, sequence_no),
            )
    _patch_schedule_json_edit(
        conn, run_id, sequence_no, asset_id, asset_type, title, duration_ms, duration_diff,
        cue_points_ms=cue_points_ms, ad_breaks=ad_breaks,
    )
    return True


def delete_entries_after(
    conn: Connection,
    channel_service_id: str,
    sequence_no: int,
) -> int:
    """Delete all active schedule entries with sequence_no > sequence_no and trim schedule_json."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT r.id
            FROM channel_schedule_runs r
            WHERE r.channel_service_id = %s AND r.is_active = true
            LIMIT 1
            """,
            (channel_service_id,),
        )
        row = cur.fetchone()
    if not row:
        return 0
    run_id = row[0]

    with conn.cursor() as cur:
        cur.execute(
            """
            DELETE FROM channel_schedule_entries
            WHERE run_id = %s AND sequence_no > %s
            """,
            (run_id, sequence_no),
        )
        deleted = cur.rowcount

    if deleted > 0:
        # Trim schedule_json entries and update window_end to the new last entry's ends_at.
        with conn.cursor() as cur:
            cur.execute("SELECT schedule_json FROM channel_schedule_runs WHERE id = %s", (run_id,))
            jr = cur.fetchone()
        if jr and jr[0]:
            payload = dict(jr[0])
            raw = payload.get("entries")
            if isinstance(raw, list):
                kept = [e for e in raw if isinstance(e, dict) and e.get("sequence_no", 0) <= sequence_no]
                payload["entries"] = kept
                payload["entry_count"] = len(kept)
                new_window_end = kept[-1]["ends_at"] if kept else payload.get("window_start")
                payload["window_end"] = new_window_end
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE channel_schedule_runs SET schedule_json = %s, window_end = %s WHERE id = %s",
                        (Jsonb(payload), new_window_end, run_id),
                    )

    return deleted


def update_ad_break_slot_asset(
    conn: Connection,
    channel_service_id: str,
    sequence_no: int,
    schedule_offset_ms: int,
    new_asset_id: str,
) -> bool:
    """Replace the asset_id of whichever ad-break sub-entry (bumper_in/slate/bumper_out)
    has schedule_offset_ms matching the given value. Only modifies schedule_json; DB entry
    rows are unchanged (duration stays the same). Returns True if the slot was found."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT r.id, r.schedule_json
            FROM channel_schedule_runs r
            WHERE r.channel_service_id = %s AND r.is_active = true
            LIMIT 1
            """,
            (channel_service_id,),
        )
        row = cur.fetchone()
    if not row or not row[1]:
        return False
    run_id, payload = row[0], dict(row[1])

    entries = payload.get("entries")
    if not isinstance(entries, list):
        return False

    found = False
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("sequence_no") != sequence_no:
            continue
        ad_breaks = entry.get("ad_breaks")
        if not isinstance(ad_breaks, list):
            break
        for brk in ad_breaks:
            if not isinstance(brk, dict):
                continue
            for key in ("bumper_in", "bumper_out"):
                sub = brk.get(key)
                if isinstance(sub, dict) and sub.get("schedule_offset_ms") == schedule_offset_ms:
                    sub["asset_id"] = new_asset_id
                    found = True
            for slate in brk.get("slates", []):
                if isinstance(slate, dict) and slate.get("schedule_offset_ms") == schedule_offset_ms:
                    slate["asset_id"] = new_asset_id
                    found = True
        break

    if not found:
        return False

    with conn.cursor() as cur:
        cur.execute(
            "UPDATE channel_schedule_runs SET schedule_json = %s WHERE id = %s",
            (Jsonb(payload), run_id),
        )
    return True


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

