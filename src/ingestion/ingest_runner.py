from __future__ import annotations

from pathlib import Path

import requests
from psycopg import connect

from src.api.repository import mark_feed_fetch_failure, mark_feed_fetch_success
from src.common.logging_config import get_logger
from src.ingestion.fetcher import fetch_feed_xml_with_status
from src.ingestion.parser import parse_mrss
from src.ingestion.repository import upsert_assets

logger = get_logger("ingestion.ingest_runner")


def normalize_mrss_xml_text(raw_text: str) -> str:
    start = raw_text.find("<rss")
    return raw_text[start:] if start >= 0 else raw_text


def _http_status_from_error(exc: BaseException) -> int | None:
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        return int(exc.response.status_code)
    return None


def try_ingest_feed_from_http(
    db_url: str,
    mrss_feed_id: str,
    feed_url: str,
) -> tuple[int, str | None]:
    """
    Fetch MRSS over HTTP, parse, upsert assets, update mrss_feeds row.
    Returns (assets_upserted, error_message). error_message is None on success.
    """
    try:
        xml_text, status = fetch_feed_xml_with_status(feed_url)
        text = normalize_mrss_xml_text(xml_text)
        assets = parse_mrss(text)
        with connect(db_url) as conn:
            count = upsert_assets(conn, mrss_feed_id, assets)
            mark_feed_fetch_success(conn, mrss_feed_id, http_status=status)
            conn.commit()
        logger.info(
            "Ingestion ok mrss_feed_id=%s url=%s assets_upserted=%s http=%s",
            mrss_feed_id,
            feed_url,
            count,
            status,
        )
        return count, None
    except Exception as exc:
        err = str(exc)
        http_status = _http_status_from_error(exc)
        logger.exception("Ingestion failed mrss_feed_id=%s url=%s", mrss_feed_id, feed_url)
        try:
            with connect(db_url) as conn:
                mark_feed_fetch_failure(conn, mrss_feed_id, error_message=err, http_status=http_status)
                conn.commit()
        except Exception:
            logger.exception("Could not persist feed failure for mrss_feed_id=%s", mrss_feed_id)
        return 0, err


def try_ingest_feed_from_file(
    db_url: str,
    mrss_feed_id: str,
    xml_path: str,
) -> tuple[int, str | None]:
    """Read local XML, parse, upsert, mark success (HTTP 200)."""
    try:
        path = Path(xml_path)
        xml_text = path.read_text(encoding="utf-8")
        text = normalize_mrss_xml_text(xml_text)
        assets = parse_mrss(text)
        with connect(db_url) as conn:
            count = upsert_assets(conn, mrss_feed_id, assets)
            mark_feed_fetch_success(conn, mrss_feed_id, http_status=200)
            conn.commit()
        logger.info(
            "Ingestion from file ok mrss_feed_id=%s path=%s assets_upserted=%s",
            mrss_feed_id,
            xml_path,
            count,
        )
        return count, None
    except Exception as exc:
        err = str(exc)
        logger.exception("Ingestion from file failed mrss_feed_id=%s path=%s", mrss_feed_id, xml_path)
        try:
            with connect(db_url) as conn:
                mark_feed_fetch_failure(conn, mrss_feed_id, error_message=err, http_status=None)
                conn.commit()
        except Exception:
            logger.exception("Could not persist feed failure for mrss_feed_id=%s", mrss_feed_id)
        return 0, err
