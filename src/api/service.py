from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from psycopg import connect

_EDIT_WINDOW_HOURS = 2

from src.api.repository import (
    active_schedule_entries_for_channel,
    delete_active_schedule_entry,
    get_asset_for_channel,
    get_entry_starts_at,
    insert_after_schedule_entry,
    list_channels,
    list_feeds,
    list_runs_for_channel,
    list_assets_for_channel,
    get_schedule_json_for_run,
    get_active_schedule_json_for_channel,
    update_active_schedule_entry_asset,
    update_asset_type,
    upsert_channel_mapping,
    upsert_feed,
)
from src.api.schemas import (
    ChannelRegisterRequest,
    ChannelRegisterResponse,
    ChannelResponse,
    FeedIngestRequest,
    FeedIngestResponse,
    FeedResponse,
    RunResponse,
    ScheduleEntryResponse,
    SlatePlanSlotResponse,
    AssetResponse,
)
from src.api.repository import mark_feed_fetch_failure, mark_feed_fetch_success
from src.ingestion.ingest_runner import try_ingest_feed_from_http
from src.ingestion.ingest_runner import normalize_mrss_xml_text
from src.ingestion.parser import parse_mrss
from src.ingestion.repository import upsert_assets
from src.common.logging_config import get_logger

logger = get_logger("api.service")
DEFAULT_FEED_INTERVAL_SECONDS = 900


def register_channel(db_url: str, payload: ChannelRegisterRequest) -> ChannelRegisterResponse:
    assets_upserted = 0
    ingestion_error: str | None = None

    with connect(db_url) as conn:
        feed_id, normalized_url, _interval, enabled = upsert_feed(
            conn=conn,
            mrss_url=str(payload.mrss_url),
            fetch_interval_seconds=DEFAULT_FEED_INTERVAL_SECONDS,
            enabled=payload.enabled,
        )
        channel_id = upsert_channel_mapping(
            conn=conn,
            channel_service_id=payload.channel_service_id.strip(),
            channel_name=payload.channel_name.strip(),
            country=payload.country.strip(),
            mrss_feed_id=feed_id,
        )
        conn.commit()
    logger.info(
        "Channel mapping upserted channel_service_id=%s feed_id=%s",
        channel_id,
        feed_id,
    )

    # Best-effort immediate ingestion when channel/feed is registered.
    # Registration remains successful even if ingest fails.
    logger.info("Starting immediate ingestion feed_id=%s url=%s", feed_id, normalized_url)
    assets_upserted, ingestion_error = try_ingest_feed_from_http(db_url, feed_id, normalized_url)
    if ingestion_error:
        logger.warning(
            "Immediate ingestion failed feed_id=%s error=%s",
            feed_id,
            ingestion_error,
        )
    else:
        logger.info(
            "Immediate ingestion succeeded feed_id=%s assets_upserted=%s",
            feed_id,
            assets_upserted,
        )

    return ChannelRegisterResponse(
        channel_service_id=channel_id,
        channel_name=payload.channel_name.strip(),
        country=payload.country.strip(),
        mrss_feed_id=feed_id,
        mrss_url=normalized_url,
        enabled=enabled,
        ingestion_triggered=True,
        assets_upserted=assets_upserted,
        ingestion_error=ingestion_error,
    )


def get_feeds(db_url: str) -> list[FeedResponse]:
    with connect(db_url) as conn:
        rows = list_feeds(conn)
    return [
        FeedResponse(
            id=str(row[0]),
            url=row[1],
            fetch_interval_seconds=row[2],
            enabled=row[3],
            last_fetch_at=row[4].isoformat() if row[4] else None,
            last_http_status=row[5],
            last_error=row[6],
        )
        for row in rows
    ]


def get_channels(db_url: str) -> list[ChannelResponse]:
    with connect(db_url) as conn:
        rows = list_channels(conn)
    return [
        ChannelResponse(
            channel_service_id=row[0],
            channel_name=row[1],
            country=row[2],
            mrss_feed_id=str(row[3]),
            mrss_url=row[4],
        )
        for row in rows
    ]


def get_channel_runs(db_url: str, channel_service_id: str) -> list[RunResponse]:
    with connect(db_url) as conn:
        rows = list_runs_for_channel(conn, channel_service_id)
    return [
        RunResponse(
            id=str(row[0]),
            status=row[1],
            is_active=row[2],
            generated_entry_count=row[3],
            created_at=row[4].isoformat(),
            error_message=row[5],
        )
        for row in rows
    ]


def _cue_points_from_json(raw: object) -> list[int]:
    if not isinstance(raw, list):
        return []
    out: list[int] = []
    for x in raw:
        try:
            out.append(int(x))
        except (TypeError, ValueError):
            continue
    return out


def _slate_plan_from_json(raw: object) -> list[SlatePlanSlotResponse]:
    if not isinstance(raw, list):
        return []
    out: list[SlatePlanSlotResponse] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        raw_cue = item.get("cue_point_ms")
        raw_dur = item.get("slate_duration_ms", 0)
        aid = item.get("slate_asset_id")
        if aid is None or str(aid).strip() == "":
            continue
        try:
            cue_point_ms = int(float(raw_cue))
            slate_duration_ms = max(1, int(float(raw_dur)))
        except (TypeError, ValueError):
            continue
        out.append(
            SlatePlanSlotResponse(
                cue_point_ms=cue_point_ms,
                slate_asset_id=str(aid).strip(),
                slate_duration_ms=slate_duration_ms,
            )
        )
    return out


def _normalize_schedule_payload(payload: object) -> dict | None:
    """JSONB may decode as dict; some drivers return serialized JSON as str."""
    if payload is None:
        return None
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return None
    return payload if isinstance(payload, dict) else None


def get_active_schedule(db_url: str, channel_service_id: str) -> list[ScheduleEntryResponse]:
    """
    Playlist rows from DB plus cue/slate metadata merged from the active run's schedule_json.
    Ad slates at cue points are not separate DB rows; they only appear in JSON until merged here.
    """
    with connect(db_url) as conn:
        rows = active_schedule_entries_for_channel(conn, channel_service_id)
        payload = _normalize_schedule_payload(
            get_active_schedule_json_for_channel(conn, channel_service_id)
        )

    json_by_seq: dict[int, dict] = {}
    json_by_asset_id: dict[str, dict] = {}
    raw_entries = payload.get("entries") if payload else None
    if isinstance(raw_entries, list):
        for je in raw_entries:
            if not isinstance(je, dict):
                continue
            seq = je.get("sequence_no")
            if not isinstance(seq, bool) and seq is not None:
                try:
                    json_by_seq[int(seq)] = je
                except (TypeError, ValueError):
                    pass
            aid = je.get("asset_id")
            if isinstance(aid, str) and aid.strip():
                json_by_asset_id[aid.strip()] = je

    result: list[ScheduleEntryResponse] = []
    for row in rows:
        seq = row[0]
        asset_id = row[3]
        seq_key: int | None
        try:
            seq_key = int(seq) if seq is not None else None
        except (TypeError, ValueError):
            seq_key = None
        je = json_by_seq.get(seq_key) if seq_key is not None else None
        if je is None and isinstance(asset_id, str) and asset_id.strip():
            je = json_by_asset_id.get(asset_id.strip())
        cue_points_ms = _cue_points_from_json(je.get("cue_points_ms")) if je else []
        slate_plan = _slate_plan_from_json(je.get("slate_plan")) if je else []
        result.append(
            ScheduleEntryResponse(
                sequence_no=row[0],
                starts_at=row[1].isoformat(),
                ends_at=row[2].isoformat(),
                asset_id=row[3],
                asset_type=row[4],
                title=row[5],
                cue_points_ms=cue_points_ms,
                slate_plan=slate_plan,
            )
        )
    return result


def get_channel_assets(db_url: str, channel_service_id: str) -> list[AssetResponse]:
    with connect(db_url) as conn:
        rows = list_assets_for_channel(conn, channel_service_id)
    return [
        AssetResponse(
            asset_id=row[0],
            asset_type=row[1],
            title=row[2],
            season_number=row[3],
            episode_number=row[4],
            duration_ms=row[5],
            valid_from=row[6].isoformat() if row[6] else None,
            valid_to=row[7].isoformat() if row[7] else None,
            last_seen_at=row[8].isoformat(),
        )
        for row in rows
    ]


def get_run_schedule_json(db_url: str, channel_service_id: str, run_id: str) -> dict | None:
    with connect(db_url) as conn:
        return get_schedule_json_for_run(conn, channel_service_id, run_id)


def get_active_schedule_json(db_url: str, channel_service_id: str) -> dict | None:
    with connect(db_url) as conn:
        return get_active_schedule_json_for_channel(conn, channel_service_id)


def ingest_feed_xml(
    db_url: str,
    mrss_feed_id: str,
    payload: FeedIngestRequest,
) -> FeedIngestResponse:
    try:
        xml_text = normalize_mrss_xml_text(payload.xml_text)
        assets = parse_mrss(xml_text)
        with connect(db_url) as conn:
            assets_upserted = upsert_assets(conn, mrss_feed_id, assets)
            mark_feed_fetch_success(
                conn,
                mrss_feed_id=mrss_feed_id,
                http_status=payload.http_status,
            )
            conn.commit()
        return FeedIngestResponse(
            mrss_feed_id=mrss_feed_id,
            source_url=str(payload.source_url),
            assets_upserted=assets_upserted,
            ingestion_error=None,
        )
    except Exception as exc:
        err = str(exc)
        try:
            with connect(db_url) as conn:
                mark_feed_fetch_failure(
                    conn,
                    mrss_feed_id=mrss_feed_id,
                    error_message=err,
                    http_status=payload.http_status,
                )
                conn.commit()
        except Exception:
            logger.exception("Could not persist feed failure for mrss_feed_id=%s", mrss_feed_id)
        return FeedIngestResponse(
            mrss_feed_id=mrss_feed_id,
            source_url=str(payload.source_url),
            assets_upserted=0,
            ingestion_error=err,
        )


def _assert_within_edit_window(starts_at: datetime, sequence_no: int) -> None:
    now = datetime.now(timezone.utc)
    if starts_at.tzinfo is None:
        starts_at = starts_at.replace(tzinfo=timezone.utc)
    if starts_at <= now:
        raise ValueError(f"Entry #{sequence_no} has already started and cannot be edited")
    if starts_at > now + timedelta(hours=_EDIT_WINDOW_HOURS):
        raise ValueError(
            f"Entry #{sequence_no} starts more than {_EDIT_WINDOW_HOURS} hours from now and cannot be edited"
        )


def delete_entry(db_url: str, channel_service_id: str, sequence_no: int) -> None:
    with connect(db_url) as conn:
        starts_at = get_entry_starts_at(conn, channel_service_id, sequence_no)
        if starts_at is None:
            raise ValueError(f"Entry #{sequence_no} not found in active schedule")
        _assert_within_edit_window(starts_at, sequence_no)
        if not delete_active_schedule_entry(conn, channel_service_id, sequence_no):
            raise ValueError(f"Entry #{sequence_no} not found in active schedule")
        conn.commit()


def update_entry(db_url: str, channel_service_id: str, sequence_no: int, asset_id: str) -> None:
    with connect(db_url) as conn:
        starts_at = get_entry_starts_at(conn, channel_service_id, sequence_no)
        if starts_at is None:
            raise ValueError(f"Entry #{sequence_no} not found in active schedule")
        _assert_within_edit_window(starts_at, sequence_no)
        asset = get_asset_for_channel(conn, channel_service_id, asset_id)
        if asset is None:
            raise ValueError(f"Asset '{asset_id}' not found for channel '{channel_service_id}'")
        a_id, a_type, a_title, a_duration, _season, _episode = asset
        if not update_active_schedule_entry_asset(
            conn, channel_service_id, sequence_no, a_id, a_type, a_title, a_duration or 1
        ):
            raise ValueError(f"Entry #{sequence_no} not found in active schedule")
        conn.commit()


def set_asset_type(db_url: str, channel_service_id: str, asset_id: str, asset_type: str) -> None:
    with connect(db_url) as conn:
        found = update_asset_type(conn, channel_service_id, asset_id, asset_type)
        if not found:
            raise ValueError(f"Asset '{asset_id}' not found for channel '{channel_service_id}'")
        conn.commit()


def insert_after_entry(db_url: str, channel_service_id: str, after_sequence_no: int, asset_id: str) -> None:
    with connect(db_url) as conn:
        starts_at = get_entry_starts_at(conn, channel_service_id, after_sequence_no)
        if starts_at is None:
            raise ValueError(f"Entry #{after_sequence_no} not found in active schedule")
        _assert_within_edit_window(starts_at, after_sequence_no)
        asset = get_asset_for_channel(conn, channel_service_id, asset_id)
        if asset is None:
            raise ValueError(f"Asset '{asset_id}' not found for channel '{channel_service_id}'")
        a_id, a_type, a_title, a_duration, a_season, a_episode = asset
        if not insert_after_schedule_entry(
            conn, channel_service_id, after_sequence_no,
            a_id, a_type, a_title, a_duration or 1, a_season, a_episode,
        ):
            raise ValueError(f"Entry #{after_sequence_no} not found in active schedule")
        conn.commit()
