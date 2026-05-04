from __future__ import annotations

from datetime import datetime
from typing import Protocol

from src.scheduler.engine import build_binge_timeline
from src.scheduler.models import ScheduleAsset, ScheduleEntry


class ScheduleStrategy(Protocol):
    name: str

    def build_entries(
        self,
        episode_assets: list[ScheduleAsset],
        fallback_slates: list[ScheduleAsset],
        window_start: datetime,
        window_end: datetime,
    ) -> list[ScheduleEntry]:
        ...


class BingeStrategy:
    name = "binge"

    def build_entries(
        self,
        episode_assets: list[ScheduleAsset],
        fallback_slates: list[ScheduleAsset],
        window_start: datetime,
        window_end: datetime,
    ) -> list[ScheduleEntry]:
        return build_binge_timeline(
            episode_assets=episode_assets,
            fallback_slates=fallback_slates,
            window_start=window_start,
            window_end=window_end,
        )


STRATEGY_REGISTRY: dict[str, ScheduleStrategy] = {
    BingeStrategy.name: BingeStrategy(),
}


def get_strategy(schedule_type: str) -> ScheduleStrategy:
    try:
        return STRATEGY_REGISTRY[schedule_type]
    except KeyError as exc:
        supported = ", ".join(sorted(STRATEGY_REGISTRY.keys()))
        raise ValueError(
            f"Unsupported schedule type '{schedule_type}'. Supported: {supported}"
        ) from exc

