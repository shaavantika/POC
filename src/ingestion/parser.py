from __future__ import annotations

import re
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

from src.ingestion.models import AssetRecord

NS = {
    "media": "http://search.yahoo.com/mrss/",
    "dcterms": "http://purl.org/dc/terms/",
}


def _text(node: ET.Element | None, default: str | None = None) -> str | None:
    if node is None or node.text is None:
        return default
    value = node.text.strip()
    return value if value else default


def _int_text(node: ET.Element | None) -> int | None:
    value = _text(node)
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _parse_w3c_valid(value: str | None) -> tuple[datetime | None, datetime | None]:
    if not value:
        return None, None
    start_match = re.search(r"start=([^;]+)", value)
    end_match = re.search(r"end=([^;]+)", value)
    return _parse_dt(start_match.group(1) if start_match else None), _parse_dt(
        end_match.group(1) if end_match else None
    )


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    cleaned = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def _duration_from_segmentation(item: ET.Element) -> int | None:
    segments = item.findall("./segmentation/segment")
    if not segments:
        return None
    last = segments[-1]
    frame_text = last.attrib.get("markOutFrame")
    if frame_text is None:
        return None
    try:
        frames = int(frame_text)
    except ValueError:
        return None

    tc = item.find("./timecodeFirstFrame")
    frame_rate_raw = tc.attrib.get("frameRate") if tc is not None else None
    try:
        frame_rate = float(frame_rate_raw) if frame_rate_raw else 29.97
    except ValueError:
        frame_rate = 29.97
    if frame_rate <= 0:
        return None
    return int((frames / frame_rate) * 1000)


def _duration_from_tag(item: ET.Element) -> int | None:
    duration_text = _text(item.find("./duration"))
    if not duration_text:
        return None
    try:
        value = int(duration_text)
    except ValueError:
        return None
    # Feed uses millisecond-like values for slates (e.g. 90040).
    return value if value > 0 else None


def _segments_from_item(item: ET.Element) -> tuple[list[dict], float]:
    segments = item.findall("./segmentation/segment")
    tc = item.find("./timecodeFirstFrame")
    frame_rate_raw = tc.attrib.get("frameRate") if tc is not None else None
    try:
        frame_rate = float(frame_rate_raw) if frame_rate_raw else 29.97
    except ValueError:
        frame_rate = 29.97
    if frame_rate <= 0:
        frame_rate = 29.97

    parsed: list[dict] = []
    for seg in segments:
        try:
            mark_in = int(seg.attrib.get("markInFrame", "0"))
            mark_out = int(seg.attrib.get("markOutFrame", "0"))
        except ValueError:
            continue
        if mark_out < mark_in:
            continue
        duration_frames = (mark_out - mark_in) + 1
        duration_ms = int((duration_frames / frame_rate) * 1000)
        if duration_ms <= 0:
            continue
        parsed.append(
            {
                "order": int(seg.attrib.get("order", "0") or 0),
                "duration_ms": duration_ms,
                "insert_ad_break": str(
                    seg.attrib.get("insertAdBreak", "false")
                ).lower()
                == "true",
            }
        )
    parsed.sort(key=lambda x: x.get("order", 0))
    return parsed, frame_rate


def parse_mrss(xml_text: str) -> list[AssetRecord]:
    root = ET.fromstring(xml_text)
    channel = root.find("./channel")
    if channel is None:
        return []

    assets: list[AssetRecord] = []
    for item in channel.findall("./item"):
        episode = item.find("./episode")
        slate = item.find("./slate")
        asset_type = "episode" if episode is not None else "slate" if slate is not None else None
        if asset_type is None:
            continue

        asset_id_node = item.find("./episode/assetId") if episode is not None else item.find("./slate/assetId")
        asset_id = _text(asset_id_node)
        if not asset_id:
            continue

        title = _text(item.find("./media:title", NS))
        description = _text(item.find("./media:description", NS))
        rating = _text(item.find("./media:rating", NS))
        genre = _text(item.find("./media:category", NS))
        tms_id = _text(item.find("./tmsId"))
        subtitle_url = item.find("./media:subTitle", NS).attrib.get("href") if item.find("./media:subTitle", NS) is not None else None
        thumbnail_url = item.find("./media:thumbnail", NS).attrib.get("url") if item.find("./media:thumbnail", NS) is not None else None

        season_id = _text(item.find("./episode/seasonId"))
        season_number = _int_text(item.find("./episode/seasonNumber"))
        episode_number = _int_text(item.find("./episode/episodeNumber"))

        valid_text = _text(item.find("./dcterms:valid", NS))
        valid_from, valid_to = _parse_w3c_valid(valid_text)

        duration_ms = _duration_from_segmentation(item) or _duration_from_tag(item)
        segment_data, frame_rate = _segments_from_item(item)

        assets.append(
            AssetRecord(
                asset_id=asset_id,
                asset_type=asset_type,
                title=title,
                description=description,
                rating=rating,
                genre=genre,
                tms_id=tms_id,
                series_id=None,
                season_id=season_id,
                season_number=season_number,
                episode_number=episode_number,
                thumbnail_url=thumbnail_url,
                subtitle_url=subtitle_url,
                valid_from=valid_from,
                valid_to=valid_to,
                duration_ms=duration_ms,
                raw_payload={
                    "valid_raw": valid_text,
                    "last_updated": item.attrib.get("lastUpdated"),
                    "frame_rate": frame_rate,
                    "segments": segment_data,
                },
            )
        )
    return assets

