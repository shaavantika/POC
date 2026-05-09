from __future__ import annotations

import requests


def _session() -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    return session


def fetch_feed_xml(feed_url: str, timeout_seconds: int = 30) -> str:
    # Ignore ambient proxy env vars for feed ingestion.
    # This avoids local/corporate proxy settings causing CloudFront tunnel failures.
    response = _session().get(feed_url, timeout=timeout_seconds)
    response.raise_for_status()
    return response.text


def fetch_feed_xml_with_status(feed_url: str, timeout_seconds: int = 30) -> tuple[str, int]:
    """Return (body text, HTTP status). Raises requests.HTTPError on non-2xx."""
    response = _session().get(feed_url, timeout=timeout_seconds)
    response.raise_for_status()
    return response.text, response.status_code

