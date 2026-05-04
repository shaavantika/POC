from __future__ import annotations

import argparse
import os

from src.scheduler.service import generate_schedule
from src.scheduler.strategies import STRATEGY_REGISTRY


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate and activate a binge schedule for one channel."
    )
    parser.add_argument("--channel-service-id", required=True)
    parser.add_argument("--db-url", default=os.getenv("DATABASE_URL"))
    parser.add_argument("--window-hours", type=int, default=24)
    parser.add_argument(
        "--trigger-type",
        choices=["auto", "manual", "recovery"],
        default="manual",
    )
    parser.add_argument(
        "--schedule-type",
        choices=sorted(STRATEGY_REGISTRY.keys()),
        default="binge",
    )
    return parser


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    if not args.db_url:
        raise SystemExit("Missing --db-url (or DATABASE_URL env var)")
    if args.window_hours <= 0:
        raise SystemExit("--window-hours must be > 0")

    result = generate_schedule(
        db_url=args.db_url,
        channel_service_id=args.channel_service_id,
        window_hours=args.window_hours,
        trigger_type=args.trigger_type,
        schedule_type=args.schedule_type,
    )
    print(
        f"Generated run {result.run_id} for channel "
        f"{result.channel_service_id} with {result.entry_count} entries"
    )


if __name__ == "__main__":
    main()

