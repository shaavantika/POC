from __future__ import annotations

import os
import sys
from pathlib import Path

# Repo root (…/Scheduler). Enables `python src/api/main.py` without PYTHONPATH when cwd is wrong.
_root = Path(__file__).resolve().parents[2]
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse

from src.api.schemas import (
    AssetTypeUpdateRequest,
    ChannelRegisterRequest,
    ChannelRegisterResponse,
    ChannelResponse,
    FeedIngestRequest,
    FeedIngestResponse,
    FeedResponse,
    RunResponse,
    ScheduleEntryResponse,
    ScheduleEntryPatchRequest,
    AssetResponse,
    GenerateScheduleRequest,
    GenerateScheduleResponse,
)
from src.api.service import (
    delete_entry,
    get_active_schedule,
    get_channel_runs,
    get_channels,
    get_feeds,
    ingest_feed_xml,
    insert_after_entry,
    get_channel_assets,
    get_run_schedule_json,
    get_active_schedule_json,
    register_channel,
    set_asset_type,
    update_entry,
)
from src.common.logging_config import get_logger, setup_logging
from src.scheduler.service import generate_schedule

setup_logging()
logger = get_logger("api.main")
app = FastAPI(title="Automatic O&O Channel Scheduler API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    logger.debug("Health check requested")
    return {"status": "ok"}


@app.get("/swagger", include_in_schema=False)
def swagger_redirect() -> RedirectResponse:
    """Convenience alias for FastAPI Swagger UI."""
    return RedirectResponse(url="/docs")


@app.post("/channels/register", response_model=ChannelRegisterResponse)
def register_channel_route(payload: ChannelRegisterRequest) -> ChannelRegisterResponse:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not set")
    try:
        logger.info(
            "Register channel request channel_service_id=%s mrss_url=%s",
            payload.channel_service_id,
            payload.mrss_url,
        )
        response = register_channel(db_url=db_url, payload=payload)
        logger.info(
            "Register channel completed channel_service_id=%s feed_id=%s assets_upserted=%s ingestion_error=%s",
            response.channel_service_id,
            response.mrss_feed_id,
            response.assets_upserted,
            response.ingestion_error,
        )
        return response
    except Exception as exc:
        logger.exception("Register channel failed: %s", exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/feeds", response_model=list[FeedResponse])
def feeds_route() -> list[FeedResponse]:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not set")
    feeds = get_feeds(db_url)
    logger.info("Fetched feeds count=%s", len(feeds))
    return feeds


@app.post("/feeds/{mrss_feed_id}/ingest", response_model=FeedIngestResponse)
def ingest_feed_route(mrss_feed_id: str, payload: FeedIngestRequest) -> FeedIngestResponse:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not set")
    try:
        logger.info("Ingest feed payload received feed_id=%s source_url=%s", mrss_feed_id, payload.source_url)
        response = ingest_feed_xml(db_url=db_url, mrss_feed_id=mrss_feed_id, payload=payload)
        logger.info(
            "Ingest feed completed feed_id=%s assets_upserted=%s ingestion_error=%s",
            response.mrss_feed_id,
            response.assets_upserted,
            response.ingestion_error,
        )
        return response
    except Exception as exc:
        logger.exception("Ingest feed failed feed_id=%s error=%s", mrss_feed_id, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/channels", response_model=list[ChannelResponse])
def channels_route() -> list[ChannelResponse]:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not set")
    channels = get_channels(db_url)
    logger.info("Fetched channels count=%s", len(channels))
    return channels


@app.get("/channels/{channel_service_id}/runs", response_model=list[RunResponse])
def channel_runs_route(channel_service_id: str) -> list[RunResponse]:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not set")
    runs = get_channel_runs(db_url, channel_service_id)
    logger.info(
        "Fetched channel runs channel_service_id=%s count=%s",
        channel_service_id,
        len(runs),
    )
    return runs


@app.get(
    "/channels/{channel_service_id}/schedule/active",
    response_model=list[ScheduleEntryResponse],
)
def active_schedule_route(channel_service_id: str) -> list[ScheduleEntryResponse]:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not set")
    entries = get_active_schedule(db_url, channel_service_id)
    logger.info(
        "Fetched active schedule channel_service_id=%s count=%s",
        channel_service_id,
        len(entries),
    )
    return entries


@app.get("/channels/{channel_service_id}/assets", response_model=list[AssetResponse])
def channel_assets_route(channel_service_id: str) -> list[AssetResponse]:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not set")
    assets = get_channel_assets(db_url, channel_service_id)
    logger.info(
        "Fetched channel assets channel_service_id=%s count=%s",
        channel_service_id,
        len(assets),
    )
    return assets


@app.post(
    "/channels/{channel_service_id}/schedule/generate",
    response_model=GenerateScheduleResponse,
)
def generate_schedule_route(
    channel_service_id: str, payload: GenerateScheduleRequest
) -> GenerateScheduleResponse:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not set")
    try:
        logger.info(
            "Generate schedule request channel_service_id=%s window_hours=%s trigger_type=%s schedule_type=%s",
            channel_service_id,
            payload.window_hours,
            payload.trigger_type,
            payload.schedule_type,
        )
        result = generate_schedule(
            db_url=db_url,
            channel_service_id=channel_service_id,
            window_hours=payload.window_hours,
            trigger_type=payload.trigger_type,
            schedule_type=payload.schedule_type,
        )
        logger.info(
            "Generate schedule completed channel_service_id=%s run_id=%s entry_count=%s",
            result.channel_service_id,
            result.run_id,
            result.entry_count,
        )
        return GenerateScheduleResponse(
            channel_service_id=result.channel_service_id,
            run_id=result.run_id,
            entry_count=result.entry_count,
        )
    except Exception as exc:
        logger.exception("Generate schedule failed channel_service_id=%s error=%s", channel_service_id, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/channels/{channel_service_id}/schedule/active/download")
def download_active_schedule_route(channel_service_id: str) -> JSONResponse:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not set")
    payload = get_active_schedule_json(db_url, channel_service_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Active schedule JSON not found")
    headers = {
        "Content-Disposition": f'attachment; filename="{channel_service_id}_active_schedule.json"'
    }
    return JSONResponse(content=payload, headers=headers)


@app.get("/channels/{channel_service_id}/runs/{run_id}/schedule/download")
def download_run_schedule_route(channel_service_id: str, run_id: str) -> JSONResponse:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not set")
    payload = get_run_schedule_json(db_url, channel_service_id, run_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Run schedule JSON not found")
    headers = {
        "Content-Disposition": f'attachment; filename="{channel_service_id}_{run_id}_schedule.json"'
    }
    return JSONResponse(content=payload, headers=headers)


@app.delete("/channels/{channel_service_id}/schedule/entries/{sequence_no}", status_code=204)
def delete_entry_route(channel_service_id: str, sequence_no: int) -> None:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not set")
    try:
        delete_entry(db_url, channel_service_id, sequence_no)
        logger.info("Entry deleted channel_service_id=%s sequence_no=%s", channel_service_id, sequence_no)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.patch("/channels/{channel_service_id}/assets/{asset_id}", status_code=204)
def update_asset_type_route(
    channel_service_id: str, asset_id: str, payload: AssetTypeUpdateRequest
) -> None:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not set")
    try:
        set_asset_type(db_url, channel_service_id, asset_id, payload.asset_type)
        logger.info(
            "Asset type updated channel_service_id=%s asset_id=%s asset_type=%s",
            channel_service_id, asset_id, payload.asset_type,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/channels/{channel_service_id}/schedule/entries/{sequence_no}/insert-after", status_code=204)
def insert_after_route(
    channel_service_id: str, sequence_no: int, payload: ScheduleEntryPatchRequest
) -> None:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not set")
    try:
        insert_after_entry(db_url, channel_service_id, sequence_no, payload.asset_id)
        logger.info(
            "Entry inserted after channel_service_id=%s sequence_no=%s asset_id=%s",
            channel_service_id, sequence_no, payload.asset_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.patch("/channels/{channel_service_id}/schedule/entries/{sequence_no}", status_code=204)
def update_entry_route(
    channel_service_id: str, sequence_no: int, payload: ScheduleEntryPatchRequest
) -> None:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not set")
    try:
        update_entry(db_url, channel_service_id, sequence_no, payload.asset_id)
        logger.info(
            "Entry updated channel_service_id=%s sequence_no=%s asset_id=%s",
            channel_service_id,
            sequence_no,
            payload.asset_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def run() -> None:
    logger.info("Starting API server")
    uvicorn.run(
        "src.api.main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        reload=False,
    )


if __name__ == "__main__":
    run()

