from __future__ import annotations

from pydantic import BaseModel, Field, HttpUrl


class ChannelRegisterRequest(BaseModel):
    channel_service_id: str = Field(min_length=1, max_length=255)
    mrss_url: HttpUrl
    xml_file_path: str | None = None
    fetch_interval_seconds: int = Field(default=900, gt=0, le=86400)
    enabled: bool = True


class ChannelRegisterResponse(BaseModel):
    channel_service_id: str
    mrss_feed_id: str
    mrss_url: str
    fetch_interval_seconds: int
    enabled: bool
    ingestion_triggered: bool
    assets_upserted: int
    ingestion_error: str | None = None


class FeedResponse(BaseModel):
    id: str
    url: str
    fetch_interval_seconds: int
    enabled: bool
    last_fetch_at: str | None
    last_http_status: int | None
    last_error: str | None


class ChannelResponse(BaseModel):
    channel_service_id: str
    mrss_feed_id: str
    mrss_url: str


class RunResponse(BaseModel):
    id: str
    status: str
    is_active: bool
    generated_entry_count: int
    created_at: str
    error_message: str | None


class ScheduleEntryResponse(BaseModel):
    sequence_no: int
    starts_at: str
    ends_at: str
    asset_id: str
    asset_type: str
    title: str | None


class AssetResponse(BaseModel):
    asset_id: str
    asset_type: str
    title: str | None
    season_number: int | None
    episode_number: int | None
    duration_ms: int | None
    valid_from: str | None
    valid_to: str | None
    last_seen_at: str


class GenerateScheduleRequest(BaseModel):
    window_hours: int = Field(default=24, gt=0, le=168)
    trigger_type: str = Field(default="manual")
    schedule_type: str = Field(default="binge")


class GenerateScheduleResponse(BaseModel):
    channel_service_id: str
    run_id: str
    entry_count: int

