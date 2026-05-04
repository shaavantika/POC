from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(slots=True)
class SegmentSpec:
    order: int
    duration_ms: int
    insert_ad_break: bool


@dataclass(slots=True)
class ScheduleAsset:
    asset_id: str
    asset_type: str
    title: str | None
    season_number: int | None
    episode_number: int | None
    duration_ms: int
    valid_from: datetime | None = None
    valid_to: datetime | None = None
    segments: list[SegmentSpec] | None = None


@dataclass(slots=True)
class ScheduleEntry:
    sequence_no: int
    starts_at: datetime
    ends_at: datetime
    asset_id: str
    asset_type: str
    title: str | None
    season_number: int | None
    episode_number: int | None
    duration_ms: int

