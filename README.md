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

Swagger/OpenAPI docs:

- Swagger UI: `http://localhost:8000/docs` (or `http://localhost:8000/swagger`)
- OpenAPI JSON: `http://localhost:8000/openapi.json`

### Register channel request

```bash
curl -X POST "http://localhost:8000/channels/register" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_service_id": "US_binge_channel_001",
    "channel_name": "Binge Channel 001",
    "country": "US",
    "mrss_url": "https://d1qcz22vwvqn9h.cloudfront.net/US4900002OH.xml",
    "enabled": true
  }'
```

`channel_service_id` must start with the country code (case-insensitive), e.g. `US_...` for country `US`.

## Lambda MRSS Polling (API-driven)

This repo includes Lambda code under `lambda/` (`lambda/mrss_poller.py`). It:

1. Calls `GET /feeds`
2. Fetches each enabled MRSS URL
3. Posts XML to `POST /feeds/{mrss_feed_id}/ingest` to upsert assets in DB

Required Lambda env var:

- `API_BASE_URL` (example: `https://your-api.example.com`)

Optional env vars:

- `API_TIMEOUT_SECONDS` (default `30`)
- `MAX_FEEDS_PER_RUN` (default `200`)
- `API_KEY` (sent as `x-api-key`, if your API gateway requires it)

Lambda handler:

- `mrss_poller.handler` (when packaging/deploying from the `lambda/` directory)

