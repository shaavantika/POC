from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from src.scheduler.models import ScheduleEntry


@dataclass(slots=True)
class ValidationResult:
    ok: bool
    message: str | None = None


def validate_entries(
    entries: list[ScheduleEntry],
    window_start: datetime,
    window_end: datetime,
    minimum_coverage_ratio: float = 0.95,
) -> ValidationResult:
    if not entries:
        return ValidationResult(ok=False, message="No entries generated")

    for i, entry in enumerate(entries):
        if entry.ends_at <= entry.starts_at:
            return ValidationResult(
                ok=False,
                message=f"Invalid duration at sequence_no={entry.sequence_no}",
            )
        if i > 0 and entry.starts_at < entries[i - 1].ends_at:
            return ValidationResult(
                ok=False,
                message=f"Overlap detected near sequence_no={entry.sequence_no}",
            )

    if entries[0].starts_at > window_start + timedelta(seconds=1):
        return ValidationResult(ok=False, message="Schedule does not start near window start")

    generated_coverage = entries[-1].ends_at - entries[0].starts_at
    target_coverage = window_end - window_start
    if target_coverage.total_seconds() <= 0:
        return ValidationResult(ok=False, message="Invalid scheduling window")

    ratio = generated_coverage.total_seconds() / target_coverage.total_seconds()
    if ratio < minimum_coverage_ratio:
        return ValidationResult(
            ok=False,
            message=(
                f"Coverage too low ({ratio:.2%}); "
                f"minimum required {minimum_coverage_ratio:.0%}"
            ),
        )

    return ValidationResult(ok=True)

