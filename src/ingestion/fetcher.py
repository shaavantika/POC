from __future__ import annotations

import requests


def fetch_feed_xml(feed_url: str, timeout_seconds: int = 30) -> str:
    # Ignore ambient proxy env vars for feed ingestion.
    # This avoids local/corporate proxy settings causing CloudFront tunnel failures.
    session = requests.Session()
    session.trust_env = False
    response = session.get(feed_url, timeout=timeout_seconds)
    response.raise_for_status()
    return response.text

