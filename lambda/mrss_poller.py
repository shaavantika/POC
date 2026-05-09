from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import requests


@dataclass(slots=True)
class PollResult:
    feed_id: str
    url: str
    ok: bool
    assets_upserted: int = 0
    error: str | None = None


def _api_base_url() -> str:
    base = os.getenv("API_BASE_URL", "").strip().rstrip("/")
    if not base:
        raise RuntimeError("Missing API_BASE_URL")
    return base


def _timeout_seconds() -> int:
    raw = os.getenv("API_TIMEOUT_SECONDS", "30").strip()
    try:
        return max(1, int(raw))
    except ValueError:
        return 30


def _api_headers() -> dict[str, str]:
    headers: dict[str, str] = {"Content-Type": "application/json"}
    api_key = os.getenv("API_KEY", "").strip()
    if api_key:
        headers["x-api-key"] = api_key
    return headers


def _list_enabled_feeds(base_url: str, timeout_seconds: int) -> list[dict[str, Any]]:
    res = requests.get(f"{base_url}/feeds", timeout=timeout_seconds, headers=_api_headers())
    res.raise_for_status()
    data = res.json()
    return [row for row in data if row.get("enabled") and row.get("url")]


def _fetch_mrss(url: str, timeout_seconds: int) -> tuple[str, int]:
    response = requests.get(url, timeout=timeout_seconds)
    response.raise_for_status()
    return response.text, int(response.status_code)


def _post_ingest(
    base_url: str,
    feed_id: str,
    source_url: str,
    xml_text: str,
    http_status: int,
    timeout_seconds: int,
) -> dict[str, Any]:
    payload = {
        "xml_text": xml_text,
        "source_url": source_url,
        "http_status": http_status,
    }
    res = requests.post(
        f"{base_url}/feeds/{feed_id}/ingest",
        json=payload,
        timeout=timeout_seconds,
        headers=_api_headers(),
    )
    res.raise_for_status()
    return res.json()


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    del event, context
    base_url = _api_base_url()
    timeout_seconds = _timeout_seconds()
    max_feeds = int(os.getenv("MAX_FEEDS_PER_RUN", "200"))

    feeds = _list_enabled_feeds(base_url, timeout_seconds)[:max_feeds]
    results: list[PollResult] = []

    for feed in feeds:
        feed_id = str(feed["id"])
        url = str(feed["url"])
        try:
            xml_text, status = _fetch_mrss(url, timeout_seconds)
            ingest_response = _post_ingest(
                base_url=base_url,
                feed_id=feed_id,
                source_url=url,
                xml_text=xml_text,
                http_status=status,
                timeout_seconds=timeout_seconds,
            )
            results.append(
                PollResult(
                    feed_id=feed_id,
                    url=url,
                    ok=not bool(ingest_response.get("ingestion_error")),
                    assets_upserted=int(ingest_response.get("assets_upserted", 0)),
                    error=ingest_response.get("ingestion_error"),
                )
            )
        except Exception as exc:
            results.append(PollResult(feed_id=feed_id, url=url, ok=False, error=str(exc)))

    ok_count = sum(1 for r in results if r.ok)
    failed_count = len(results) - ok_count
    assets_total = sum(r.assets_upserted for r in results)

    return {
        "feeds_seen": len(feeds),
        "feeds_ok": ok_count,
        "feeds_failed": failed_count,
        "assets_upserted": assets_total,
        "results": [
            {
                "feed_id": r.feed_id,
                "url": r.url,
                "ok": r.ok,
                "assets_upserted": r.assets_upserted,
                "error": r.error,
            }
            for r in results
        ],
    }
