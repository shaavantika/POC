from __future__ import annotations

import argparse
import os
from pathlib import Path

from psycopg import connect

from src.common.logging_config import get_logger, setup_logging
from src.ingestion.fetcher import fetch_feed_xml
from src.ingestion.parser import parse_mrss
from src.ingestion.repository import upsert_assets

setup_logging()
logger = get_logger("ingestion.cli")

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fetch/parse MRSS and upsert normalized assets."
    )
    parser.add_argument("--mrss-feed-id", required=True, help="UUID from mrss_feeds.id")
    parser.add_argument("--db-url", default=os.getenv("DATABASE_URL"), help="Postgres DSN")
    parser.add_argument("--feed-url", help="HTTP(S) MRSS URL")
    parser.add_argument("--xml-file", help="Local XML file path")
    return parser


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    if not args.db_url:
        raise SystemExit("Missing --db-url (or DATABASE_URL env var)")
    if bool(args.feed_url) == bool(args.xml_file):
        raise SystemExit("Provide exactly one of --feed-url or --xml-file")

    if args.xml_file:
        logger.info("Loading XML from file path=%s", args.xml_file)
        xml_text = Path(args.xml_file).read_text(encoding="utf-8")
    else:
        logger.info("Fetching XML from URL url=%s", args.feed_url)
        xml_text = fetch_feed_xml(args.feed_url)

    assets = parse_mrss(xml_text)
    if not assets:
        logger.warning("No parsable assets found mrss_feed_id=%s", args.mrss_feed_id)
        print("No parsable assets found.")
        return

    with connect(args.db_url) as conn:
        count = upsert_assets(conn, args.mrss_feed_id, assets)

    logger.info("Ingestion completed mrss_feed_id=%s assets_upserted=%s", args.mrss_feed_id, count)
    print(f"Upserted {count} assets for feed {args.mrss_feed_id}")


if __name__ == "__main__":
    main()

