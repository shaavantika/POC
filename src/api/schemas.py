from __future__ import annotations

from pydantic import BaseModel, Field, HttpUrl
from pydantic import model_validator


class ChannelRegisterRequest(BaseModel):
    channel_service_id: str = Field(min_length=1, max_length=255)
    channel_name: str = Field(min_length=1, max_length=255)
    country: str = Field(min_length=1, max_length=64)
    mrss_url: HttpUrl
    enabled: bool = True

    @model_validator(mode="after")
    def validate_service_id_country_prefix(self) -> "ChannelRegisterRequest":
        service_id = self.channel_service_id.strip()
        country = self.country.strip()
        if not service_id.upper().startswith(country.upper()):
            raise ValueError("channel_service_id must start with country code")
        return self


class ChannelRegisterResponse(BaseModel):
    channel_service_id: str
    channel_name: str
    country: str
    mrss_feed_id: str
    mrss_url: str
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
    channel_name: str | None
    country: str | None
    mrss_feed_id: str
    mrss_url: str


class RunResponse(BaseModel):
    id: str
    status: str
    is_active: bool
    generated_entry_count: int
    created_at: str
    error_message: str | None


class SlatePlanSlotResponse(BaseModel):
    """Ad slate inserted at a cue point within an episode (from generated schedule_json)."""

    cue_point_ms: int
    slate_asset_id: str
    slate_duration_ms: int


class ScheduleEntryResponse(BaseModel):
    sequence_no: int
    starts_at: str
    ends_at: str
    asset_id: str
    asset_type: str
    title: str | None
    cue_points_ms: list[int] = Field(default_factory=list)
    slate_plan: list[SlatePlanSlotResponse] = Field(default_factory=list)


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


class FeedIngestRequest(BaseModel):
    xml_text: str = Field(min_length=1)
    source_url: HttpUrl
    http_status: int = Field(default=200, ge=100, le=599)


class FeedIngestResponse(BaseModel):
    mrss_feed_id: str
    source_url: str
    assets_upserted: int
    ingestion_error: str | None = None

