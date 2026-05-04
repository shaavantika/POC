from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass(slots=True)
class AssetRecord:
    asset_id: str
    asset_type: str  # episode | slate
    title: str | None = None
    description: str | None = None
    rating: str | None = None
    genre: str | None = None
    tms_id: str | None = None
    series_id: str | None = None
    season_id: str | None = None
    season_number: int | None = None
    episode_number: int | None = None
    thumbnail_url: str | None = None
    subtitle_url: str | None = None
    valid_from: datetime | None = None
    valid_to: datetime | None = None
    duration_ms: int | None = None
    raw_payload: dict[str, Any] = field(default_factory=dict)

