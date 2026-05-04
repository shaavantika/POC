from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from psycopg import connect

from src.scheduler.repository import (
    create_run,
    get_feed_id_for_channel,
    get_valid_assets,
    mark_run_failed,
    persist_entries_and_activate,
)
from src.scheduler.strategies import get_strategy
from src.scheduler.validation import validate_entries
from src.common.logging_config import get_logger

logger = get_logger("scheduler.service")


@dataclass(slots=True)
class ScheduleResult:
    run_id: str
    entry_count: int
    channel_service_id: str


def _build_schedule_json(
    channel_service_id: str,
    run_id: str,
    window_start: datetime,
    window_end: datetime,
    entries,
    cue_points_by_asset: dict[str, list[int]],
    slate_plan_by_asset: dict[str, list[dict[str, int | str]]],
) -> dict:
    return {
        "channel_service_id": channel_service_id,
        "run_id": run_id,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "entry_count": len(entries),
        "entries": [
            {
                "sequence_no": e.sequence_no,
                "starts_at": e.starts_at.isoformat(),
                "ends_at": e.ends_at.isoformat(),
                "asset_id": e.asset_id,
                "asset_type": e.asset_type,
                "title": e.title,
                "season_number": e.season_number,
                "episode_number": e.episode_number,
                "duration_ms": e.duration_ms,
                "cue_points_ms": cue_points_by_asset.get(e.asset_id, []),
                "cue_points_ms_csv": ",".join(
                    str(v) for v in cue_points_by_asset.get(e.asset_id, [])
                ),
                "slate_plan": slate_plan_by_asset.get(e.asset_id, []),
            }
            for e in entries
        ],
    }


def _build_cue_points_by_asset(episodes) -> dict[str, list[int]]:
    mapping: dict[str, list[int]] = {}
    for asset in episodes:
        if not asset.segments:
            mapping[asset.asset_id] = []
            continue
        offsets: list[int] = []
        elapsed = 0
        for seg in sorted(asset.segments, key=lambda s: s.order):
            elapsed += max(seg.duration_ms, 0)
            if seg.insert_ad_break:
                offsets.append(elapsed)
        mapping[asset.asset_id] = offsets
    return mapping


def _build_slate_plan_by_asset(
    episodes,
    slates,
    cue_points_by_asset: dict[str, list[int]],
) -> dict[str, list[dict[str, int | str]]]:
    if not slates:
        return {asset.asset_id: [] for asset in episodes}

    # Rotate through available slates while avoiding sequential repeats.
    slate_ids = [s.asset_id for s in slates]
    slate_duration_by_id = {s.asset_id: max(s.duration_ms, 1) for s in slates}
    slate_idx = 0
    last_slate_id: str | None = None
    mapping: dict[str, list[dict[str, int | str]]] = {}

    for asset in sorted(
        episodes,
        key=lambda a: (
            a.season_number if a.season_number is not None else 999999,
            a.episode_number if a.episode_number is not None else 999999,
            a.asset_id,
        ),
    ):
        plan: list[dict[str, int | str]] = []
        cue_points = cue_points_by_asset.get(asset.asset_id, [])
        for cue_point in cue_points:
            chosen_id = slate_ids[slate_idx % len(slate_ids)]
            if len(slate_ids) > 1 and chosen_id == last_slate_id:
                slate_idx += 1
                chosen_id = slate_ids[slate_idx % len(slate_ids)]
            slate_idx += 1
            last_slate_id = chosen_id
            plan.append(
                {
                    "cue_point_ms": cue_point,
                    "slate_asset_id": chosen_id,
                    "slate_duration_ms": slate_duration_by_id.get(chosen_id, 1),
                }
            )
        mapping[asset.asset_id] = plan

    return mapping


def generate_schedule(
    db_url: str,
    channel_service_id: str,
    window_hours: int = 24,
    trigger_type: str = "manual",
    schedule_type: str = "binge",
) -> ScheduleResult:
    logger.info(
        "Schedule generation started channel_service_id=%s window_hours=%s trigger_type=%s schedule_type=%s",
        channel_service_id,
        window_hours,
        trigger_type,
        schedule_type,
    )
    window_start = datetime.now(timezone.utc)
    window_end = window_start + timedelta(hours=window_hours)

    with connect(db_url) as conn:
        feed_id = get_feed_id_for_channel(conn, channel_service_id)
        if not feed_id:
            logger.error("Channel mapping missing channel_service_id=%s", channel_service_id)
            raise ValueError(f"Channel mapping not found for {channel_service_id}")

        run_id = create_run(
            conn=conn,
            channel_service_id=channel_service_id,
            window_start=window_start,
            window_end=window_end,
            trigger_type=trigger_type,
            source_feed_id=feed_id,
        )

        try:
            episodes, slates = get_valid_assets(conn, feed_id, window_start)
            strategy = get_strategy(schedule_type)
            entries = strategy.build_entries(
                episode_assets=episodes,
                fallback_slates=slates,
                window_start=window_start,
                window_end=window_end,
            )
            if not entries:
                raise ValueError("No valid assets found to build schedule")
            validation = validate_entries(
                entries=entries,
                window_start=window_start,
                window_end=window_end,
                minimum_coverage_ratio=0.95,
            )
            if not validation.ok:
                raise ValueError(validation.message or "Schedule validation failed")

            cue_points_by_asset = _build_cue_points_by_asset(episodes)
            slate_plan_by_asset = _build_slate_plan_by_asset(
                episodes=episodes,
                slates=slates,
                cue_points_by_asset=cue_points_by_asset,
            )
            persist_entries_and_activate(
                conn=conn,
                run_id=run_id,
                channel_service_id=channel_service_id,
                entries=entries,
                schedule_json=_build_schedule_json(
                    channel_service_id=channel_service_id,
                    run_id=str(run_id),
                    window_start=window_start,
                    window_end=window_end,
                    entries=entries,
                    cue_points_by_asset=cue_points_by_asset,
                    slate_plan_by_asset=slate_plan_by_asset,
                ),
            )
            conn.commit()
            logger.info(
                "Schedule generation succeeded channel_service_id=%s run_id=%s entries=%s",
                channel_service_id,
                run_id,
                len(entries),
            )
        except Exception as exc:
            logger.exception(
                "Schedule generation failed channel_service_id=%s run_id=%s error=%s",
                channel_service_id,
                run_id,
                exc,
            )
            mark_run_failed(conn, run_id, str(exc))
            conn.commit()
            raise

    return ScheduleResult(
        run_id=str(run_id),
        entry_count=len(entries),
        channel_service_id=channel_service_id,
    )

