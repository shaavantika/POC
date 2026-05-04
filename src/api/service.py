from __future__ import annotations

from pathlib import Path

from psycopg import connect

from src.api.repository import (
    active_schedule_entries_for_channel,
    list_channels,
    list_feeds,
    list_runs_for_channel,
    mark_feed_fetch_failure,
    mark_feed_fetch_success,
    list_assets_for_channel,
    get_schedule_json_for_run,
    get_active_schedule_json_for_channel,
    upsert_channel_mapping,
    upsert_feed,
)
from src.api.schemas import (
    ChannelRegisterRequest,
    ChannelRegisterResponse,
    ChannelResponse,
    FeedResponse,
    RunResponse,
    ScheduleEntryResponse,
    AssetResponse,
)
from src.ingestion.fetcher import fetch_feed_xml
from src.ingestion.parser import parse_mrss
from src.ingestion.repository import upsert_assets
from src.common.logging_config import get_logger

logger = get_logger("api.service")


def _normalize_xml_text(raw_text: str) -> str:
    start = raw_text.find("<rss")
    return raw_text[start:] if start >= 0 else raw_text


def register_channel(db_url: str, payload: ChannelRegisterRequest) -> ChannelRegisterResponse:
    assets_upserted = 0
    ingestion_error: str | None = None

    with connect(db_url) as conn:
        feed_id, normalized_url, interval, enabled = upsert_feed(
            conn=conn,
            mrss_url=str(payload.mrss_url),
            fetch_interval_seconds=payload.fetch_interval_seconds,
            enabled=payload.enabled,
        )
        channel_id = upsert_channel_mapping(
            conn=conn,
            channel_service_id=payload.channel_service_id.strip(),
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
    try:
        logger.info("Starting immediate ingestion feed_id=%s url=%s", feed_id, normalized_url)
        if payload.xml_file_path and payload.xml_file_path.strip():
            xml_path = payload.xml_file_path.strip()
            logger.info("Using local XML file for ingestion feed_id=%s path=%s", feed_id, xml_path)
            xml_text = Path(xml_path).read_text(encoding="utf-8")
        else:
            xml_text = fetch_feed_xml(normalized_url)
        assets = parse_mrss(_normalize_xml_text(xml_text))
        with connect(db_url) as conn:
            assets_upserted = upsert_assets(conn, feed_id, assets)
        with connect(db_url) as conn:
            mark_feed_fetch_success(conn, feed_id, http_status=200)
            conn.commit()
        logger.info(
            "Immediate ingestion succeeded feed_id=%s assets_upserted=%s",
            feed_id,
            assets_upserted,
        )
    except Exception as exc:
        ingestion_error = str(exc)
        logger.exception("Immediate ingestion failed feed_id=%s error=%s", feed_id, ingestion_error)
        with connect(db_url) as conn:
            mark_feed_fetch_failure(conn, feed_id, error_message=ingestion_error)
            conn.commit()

    return ChannelRegisterResponse(
        channel_service_id=channel_id,
        mrss_feed_id=feed_id,
        mrss_url=normalized_url,
        fetch_interval_seconds=interval,
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
            mrss_feed_id=str(row[1]),
            mrss_url=row[2],
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


def get_active_schedule(db_url: str, channel_service_id: str) -> list[ScheduleEntryResponse]:
    with connect(db_url) as conn:
        rows = active_schedule_entries_for_channel(conn, channel_service_id)
    return [
        ScheduleEntryResponse(
            sequence_no=row[0],
            starts_at=row[1].isoformat(),
            ends_at=row[2].isoformat(),
            asset_id=row[3],
            asset_type=row[4],
            title=row[5],
        )
        for row in rows
    ]


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

