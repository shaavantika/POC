# Binge Scheduler

Minimal ingestion skeleton for MRSS -> normalized assets in Postgres.

## Setup

1. Create and migrate database with SQL files under `db/migrations`.
2. Install dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

## Ingest from local XML

```bash
ingest-mrss \
  --db-url "$DATABASE_URL" \
  --mrss-feed-id "<mrss_feeds.id uuid>" \
  --xml-file "/path/to/feed.xml"
```

## Ingest from URL

```bash
ingest-mrss \
  --db-url "$DATABASE_URL" \
  --mrss-feed-id "<mrss_feeds.id uuid>" \
  --feed-url "https://example.com/feed.xml"
```

## Generate schedule (24h default)

```bash
generate-schedule \
  --db-url "$DATABASE_URL" \
  --channel-service-id "<channel_service_id>" \
  --window-hours 24 \
  --trigger-type manual \
  --schedule-type binge
```

## Run API (register channel + MRSS)

```bash
export DATABASE_URL="postgresql://postgres:<password>@localhost:5432/channel_scheduler"
scheduler-api
```

### Register channel request

```bash
curl -X POST "http://localhost:8000/channels/register" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_service_id": "binge_channel_001",
    "mrss_url": "https://d1qcz22vwvqn9h.cloudfront.net/US4900002OH.xml",
    "xml_file_path": null,
    "fetch_interval_seconds": 900,
    "enabled": true
  }'
```

If MRSS URL is unreachable from your environment, set `xml_file_path` to a local XML file and ingestion will read from file.

