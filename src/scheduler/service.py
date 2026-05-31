from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from psycopg import connect

from src.scheduler.repository import (
    append_entries_to_run,
    create_run,
    get_active_run_info,
    get_feed_id_for_channel,
    get_max_sequence_no,
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
    extended: bool = False


def _build_schedule_json(
    channel_service_id: str,
    run_id: str,
    window_start: datetime,
    window_end: datetime,
    entries,
    cue_points_by_asset: dict[str, list[int]],
    ad_breaks_by_asset: dict[str, list[dict]],
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
                "ad_breaks": ad_breaks_by_asset.get(e.asset_id, []),
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


def _extend_episode_durations(
    episodes: list,
    cue_points_by_asset: dict[str, list[int]],
    bumper_duration: int,
) -> list:
    """Return episodes with duration_ms extended by bumper time around each ad break."""
    if bumper_duration <= 0:
        return episodes
    from src.scheduler.models import ScheduleAsset
    extended = []
    for ep in episodes:
        num_breaks = len(cue_points_by_asset.get(ep.asset_id, []))
        extra = num_breaks * 2 * bumper_duration
        if extra == 0:
            extended.append(ep)
        else:
            extended.append(ScheduleAsset(
                asset_id=ep.asset_id,
                asset_type=ep.asset_type,
                title=ep.title,
                season_number=ep.season_number,
                episode_number=ep.episode_number,
                duration_ms=ep.duration_ms + extra,
                valid_from=ep.valid_from,
                valid_to=ep.valid_to,
                segments=ep.segments,
            ))
    return extended


def _build_ad_breaks_by_asset(
    episodes,
    slates,
    cue_points_by_asset: dict[str, list[int]],
    bumpers: list | None = None,
) -> dict[str, list[dict]]:
    """
    Returns per-episode ad break metadata grouped by cue point:
      { asset_id: [ { offset_ms, bumper_in?, slates[], bumper_out? }, ... ] }

    offset_ms          — content-relative cue point (ms into the episode video)
    schedule_offset_ms — schedule-relative offset (ms from episode starts_at); stored
                         so the API can reconstruct a flat slate list for the EPG.
    bumper_in/out      — content segments owned by the assembler, not the ad server.
    slates             — ad window; handed to the ad server / channel assembler.
    """
    if not slates:
        return {asset.asset_id: [] for asset in episodes}

    bumper = bumpers[0] if bumpers else None
    bumper_duration = bumper.duration_ms if bumper else 0

    slate_ids = [s.asset_id for s in slates]
    slate_duration_by_id = {s.asset_id: max(s.duration_ms, 1) for s in slates}
    slate_idx = 0
    last_slate_id: str | None = None
    mapping: dict[str, list[dict]] = {}

    for asset in sorted(
        episodes,
        key=lambda a: (
            a.season_number if a.season_number is not None else 999999,
            a.episode_number if a.episode_number is not None else 999999,
            a.asset_id,
        ),
    ):
        breaks: list[dict] = []
        cue_points = cue_points_by_asset.get(asset.asset_id, [])
        accumulated_extra = 0

        for cue_point in cue_points:
            schedule_cue = cue_point + accumulated_extra
            break_entry: dict = {"offset_ms": cue_point}

            if bumper:
                break_entry["bumper_in"] = {
                    "asset_id": bumper.asset_id,
                    "duration_ms": bumper_duration,
                    "schedule_offset_ms": schedule_cue,
                }
                schedule_cue += bumper_duration

            chosen_id = slate_ids[slate_idx % len(slate_ids)]
            if len(slate_ids) > 1 and chosen_id == last_slate_id:
                slate_idx += 1
                chosen_id = slate_ids[slate_idx % len(slate_ids)]
            slate_idx += 1
            last_slate_id = chosen_id
            slate_dur = slate_duration_by_id.get(chosen_id, 1)
            break_entry["slates"] = [{
                "asset_id": chosen_id,
                "duration_ms": slate_dur,
                "schedule_offset_ms": schedule_cue,
            }]
            schedule_cue += slate_dur

            if bumper:
                break_entry["bumper_out"] = {
                    "asset_id": bumper.asset_id,
                    "duration_ms": bumper_duration,
                    "schedule_offset_ms": schedule_cue,
                }
                accumulated_extra += 2 * bumper_duration

            breaks.append(break_entry)

        mapping[asset.asset_id] = breaks

    return mapping


def generate_schedule(
    db_url: str,
    channel_service_id: str,
    window_hours: int = 168,
    trigger_type: str = "manual",
    schedule_type: str = "binge",
) -> ScheduleResult:
    now = datetime.now(timezone.utc)
    target_end = now + timedelta(hours=window_hours)

    logger.info(
        "Schedule generation started channel_service_id=%s window_hours=%s trigger_type=%s schedule_type=%s",
        channel_service_id,
        window_hours,
        trigger_type,
        schedule_type,
    )

    with connect(db_url) as conn:
        feed_id = get_feed_id_for_channel(conn, channel_service_id)
        if not feed_id:
            logger.error("Channel mapping missing channel_service_id=%s", channel_service_id)
            raise ValueError(f"Channel mapping not found for {channel_service_id}")

        active = get_active_run_info(conn, channel_service_id)

        # Manual trigger always creates a fresh run (clean data).
        # Automated trigger_type="auto" appends to extend an existing run.
        if trigger_type != "manual" and active:
            existing_run_id, existing_window_end, existing_entry_count = active
            if existing_window_end >= target_end:
                logger.info(
                    "Schedule already covers target channel_service_id=%s run_id=%s window_end=%s",
                    channel_service_id,
                    existing_run_id,
                    existing_window_end,
                )
                return ScheduleResult(
                    run_id=str(existing_run_id),
                    entry_count=existing_entry_count,
                    channel_service_id=channel_service_id,
                    extended=False,
                )

            # Extend: build entries from where the existing run ends to target_end.
            gap_start = existing_window_end
            gap_end = target_end
            run_id = existing_run_id
            is_extension = True
            seq_offset = get_max_sequence_no(conn, run_id)
        else:
            gap_start = now
            gap_end = target_end
            run_id = create_run(
                conn=conn,
                channel_service_id=channel_service_id,
                window_start=gap_start,
                window_end=gap_end,
                trigger_type=trigger_type,
                source_feed_id=feed_id,
            )
            is_extension = False
            seq_offset = 0

        try:
            episodes, slates, bumpers = get_valid_assets(conn, feed_id, gap_start)
            cue_points_by_asset = _build_cue_points_by_asset(episodes)

            bumper_duration = bumpers[0].duration_ms if (bumpers and slates) else 0
            extended_episodes = _extend_episode_durations(episodes, cue_points_by_asset, bumper_duration)

            strategy = get_strategy(schedule_type)
            entries = strategy.build_entries(
                episode_assets=extended_episodes,
                fallback_slates=slates,
                window_start=gap_start,
                window_end=gap_end,
            )
            if not entries:
                raise ValueError("No valid assets found to build schedule")

            # Re-number entries if extending an existing run.
            if seq_offset > 0:
                from src.scheduler.models import ScheduleEntry
                entries = [
                    ScheduleEntry(
                        sequence_no=e.sequence_no + seq_offset,
                        starts_at=e.starts_at,
                        ends_at=e.ends_at,
                        asset_id=e.asset_id,
                        asset_type=e.asset_type,
                        title=e.title,
                        season_number=e.season_number,
                        episode_number=e.episode_number,
                        duration_ms=e.duration_ms,
                    )
                    for e in entries
                ]

            validation = validate_entries(
                entries=entries,
                window_start=gap_start,
                window_end=gap_end,
                minimum_coverage_ratio=0.95,
            )
            if not validation.ok:
                raise ValueError(validation.message or "Schedule validation failed")

            ad_breaks_by_asset = _build_ad_breaks_by_asset(
                episodes=episodes,
                slates=slates,
                cue_points_by_asset=cue_points_by_asset,
                bumpers=bumpers,
            )

            new_entries_json = _build_schedule_json(
                channel_service_id=channel_service_id,
                run_id=str(run_id),
                window_start=gap_start,
                window_end=gap_end,
                entries=entries,
                cue_points_by_asset=cue_points_by_asset,
                ad_breaks_by_asset=ad_breaks_by_asset,
            )["entries"]

            if is_extension:
                append_entries_to_run(
                    conn=conn,
                    run_id=run_id,
                    channel_service_id=channel_service_id,
                    entries=entries,
                    new_window_end=gap_end,
                    new_entries_json=new_entries_json,
                )
            else:
                full_json = _build_schedule_json(
                    channel_service_id=channel_service_id,
                    run_id=str(run_id),
                    window_start=gap_start,
                    window_end=gap_end,
                    entries=entries,
                    cue_points_by_asset=cue_points_by_asset,
                    ad_breaks_by_asset=ad_breaks_by_asset,
                )
                persist_entries_and_activate(
                    conn=conn,
                    run_id=run_id,
                    channel_service_id=channel_service_id,
                    entries=entries,
                    schedule_json=full_json,
                )

            conn.commit()
            logger.info(
                "Schedule generation succeeded channel_service_id=%s run_id=%s entries=%s extended=%s",
                channel_service_id,
                run_id,
                len(entries),
                is_extension,
            )
        except Exception as exc:
            logger.exception(
                "Schedule generation failed channel_service_id=%s run_id=%s error=%s",
                channel_service_id,
                run_id,
                exc,
            )
            if not is_extension:
                mark_run_failed(conn, run_id, str(exc))
                conn.commit()
            raise

    return ScheduleResult(
        run_id=str(run_id),
        entry_count=len(entries),
        channel_service_id=channel_service_id,
        extended=is_extension,
    )

