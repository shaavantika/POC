from __future__ import annotations

from datetime import datetime, timedelta, timezone

from src.scheduler.models import ScheduleAsset, ScheduleEntry


def _sort_key(asset: ScheduleAsset) -> tuple[int, int, str]:
    season = asset.season_number if asset.season_number is not None else 999999
    episode = asset.episode_number if asset.episode_number is not None else 999999
    return season, episode, asset.asset_id


def build_binge_timeline(
    episode_assets: list[ScheduleAsset],
    fallback_slates: list[ScheduleAsset],
    window_start: datetime,
    window_end: datetime,
) -> list[ScheduleEntry]:
    if window_start.tzinfo is None:
        window_start = window_start.replace(tzinfo=timezone.utc)
    if window_end.tzinfo is None:
        window_end = window_end.replace(tzinfo=timezone.utc)

    sorted_episodes = sorted(episode_assets, key=_sort_key)
    slate_pool = fallback_slates[:]

    entries: list[ScheduleEntry] = []
    cursor = window_start
    sequence = 1
    idx = 0

    def is_valid_at(asset: ScheduleAsset, at_time: datetime) -> bool:
        if asset.valid_from is not None and asset.valid_from > at_time:
            return False
        if asset.valid_to is not None and asset.valid_to <= at_time:
            return False
        return True

    def choose_asset(at_time: datetime) -> ScheduleAsset | None:
        nonlocal idx
        if sorted_episodes:
            # Preserve binge sequence while skipping invalid-at-slot assets.
            for _ in range(len(sorted_episodes)):
                asset = sorted_episodes[idx % len(sorted_episodes)]
                idx += 1
                if is_valid_at(asset, at_time):
                    return asset
        if slate_pool:
            for offset in range(len(slate_pool)):
                slate = slate_pool[(sequence - 1 + offset) % len(slate_pool)]
                if is_valid_at(slate, at_time):
                    return slate
        return None

    while cursor < window_end:
        asset = choose_asset(cursor)
        if asset is None:
            break
        duration_ms = max(asset.duration_ms, 1)
        end_time = cursor + timedelta(milliseconds=duration_ms)
        if end_time <= cursor:
            end_time = cursor + timedelta(milliseconds=1)

        entries.append(
            ScheduleEntry(
                sequence_no=sequence,
                starts_at=cursor,
                ends_at=end_time,
                asset_id=asset.asset_id,
                asset_type=asset.asset_type,
                title=asset.title,
                season_number=asset.season_number,
                episode_number=asset.episode_number,
                duration_ms=duration_ms,
            )
        )
        cursor = end_time
        sequence += 1

    return entries

