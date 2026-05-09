"""
Cron-friendly MRSS poller: loads feeds from Postgres that are due (by fetch_interval_seconds),
fetches each URL, parses MRSS, upserts assets.

Typical crontab (run often; each feed still respects its own interval in the DB):

    */5 * * * * cd /path/to/Scheduler && DATABASE_URL=... .venv/bin/poll-mrss-feeds >> logs/poll.log 2>&1

Or every minute:

    * * * * * ...

Requires DATABASE_URL (or pass --db-url).
"""

from __future__ import annotations

import argparse
import os
import sys

from psycopg import connect

from src.api.repository import list_due_mrss_feeds
from src.common.logging_config import get_logger, setup_logging
from src.ingestion.ingest_runner import try_ingest_feed_from_http

setup_logging()
logger = get_logger("ingestion.poll_feeds")


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Poll MRSS feeds that are due based on mrss_feeds.fetch_interval_seconds "
            "and last_fetch_at. Intended for cron."
        )
    )
    p.add_argument(
        "--db-url",
        default=os.environ.get("DATABASE_URL"),
        help="Postgres connection URL (default: DATABASE_URL env)",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=200,
        metavar="N",
        help="Max feeds to process per run (default: 200)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Only list due feed ids and URLs; do not fetch",
    )
    return p.parse_args()


def main() -> None:
    args = _parse_args()
    if not args.db_url:
        logger.error("Missing DATABASE_URL or --db-url")
        sys.exit(2)

    with connect(args.db_url) as conn:
        due = list_due_mrss_feeds(conn, limit=args.limit)

    logger.info("poll_feeds due_count=%s dry_run=%s", len(due), args.dry_run)

    if args.dry_run:
        for feed_id, url in due:
            print(f"{feed_id}\t{url}")
        return

    ok = 0
    failed = 0
    assets_total = 0
    for feed_id, url in due:
        n, err = try_ingest_feed_from_http(args.db_url, feed_id, url)
        if err:
            failed += 1
            logger.error("feed_failed id=%s url=%s err=%s", feed_id, url, err)
        else:
            ok += 1
            assets_total += n

    logger.info(
        "poll_feeds complete feeds_ok=%s feeds_failed=%s assets_upserted=%s",
        ok,
        failed,
        assets_total,
    )
    print(f"poll_feeds: ok={ok} failed={failed} assets_upserted={assets_total}")


if __name__ == "__main__":
    main()
