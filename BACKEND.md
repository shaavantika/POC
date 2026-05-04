# Backend Technical Document

## 1) Overview

This backend service ingests MRSS feeds and generates binge-channel schedules.

Primary responsibilities:
- Fetch and parse MRSS XML.
- Normalize feed items into canonical assets.
- Persist assets for deterministic schedule generation.
- Generate and activate versioned schedules per channel.
- Preserve service continuity with fallback to last active schedule.

Current implementation status:
- Core schema migrations are present.
- Ingestion CLI is implemented.
- Schedule generation CLI is implemented.
- API server and background workers are pending.

---

## 2) Backend Architecture

Logical layers:
1. **Data Layer (Postgres)**
   - Feed registry, normalized assets, schedule versions, schedule entries.
2. **Ingestion Layer**
   - Feed fetcher + MRSS parser + asset upsert repository.
3. **Scheduling Layer**
   - Asset loader + strategy selector + schedule engine + run/activation repository.
4. **Control Layer (planned)**
   - REST endpoints for configuration and manual operations.
5. **Operations Layer (planned)**
   - Polling workers, metrics, logs, alerting.

Design principles:
- Idempotent writes.
- Deterministic ordering.
- Failure isolation (fetch/parse/generate failures do not remove active schedule).
- Production-safe default behavior (fallback on last known good).
- Open/closed strategy design (add new scheduling modes without rewriting core pipeline).

---

## 3) Codebase Structure

Current folders/files:
- `src/ingestion/`
  - `cli.py`: ingestion command entrypoint
  - `fetcher.py`: HTTP feed fetch utility
  - `parser.py`: MRSS parsing + normalization
  - `repository.py`: upsert to `mrss_assets`
  - `models.py`: canonical parsed asset model
- `src/scheduler/`
  - `cli.py`: schedule generation command entrypoint
  - `engine.py`: binge timeline generation algorithm
  - `repository.py`: schedule DB operations
  - `service.py`: orchestration for a schedule run
  - `models.py`: scheduler in-memory models
- `db/migrations/`
  - `001_channel_mrss_sources.sql`
  - `002_mrss_feeds_shared_url.sql`
  - `003_assets_and_schedule_tables.sql`

---

## 4) Database Model

### 4.1 Feed Registry

#### `channel_mrss_sources`
- Maps `channel_service_id` -> `mrss_feed_id`.
- One row per channel.

Key fields:
- `channel_service_id` (unique, non-empty)
- `mrss_feed_id` (FK to `mrss_feeds`)
- `created_at`, `updated_at`

#### `mrss_feeds`
- One row per distinct MRSS URL.
- Shared by multiple channels.

Key fields:
- `url` (unique)
- `fetch_interval_seconds`
- `enabled`
- HTTP metadata: `etag`, `last_modified`
- fetch status: `last_fetch_at`, `last_success_at`, `last_http_status`, `last_error`
- `created_at`, `updated_at`

### 4.2 Asset Catalog

#### `mrss_assets`
- Canonical normalized feed items.
- Unique by `(mrss_feed_id, asset_id)`.

Key fields:
- identity/type: `asset_id`, `asset_type` (`episode|slate`)
- hierarchy: `series_id`, `season_id`, `season_number`, `episode_number`
- metadata: `title`, `description`, `rating`, `genre`, `tms_id`
- media refs: `thumbnail_url`, `subtitle_url`
- rights: `valid_from`, `valid_to`
- runtime: `duration_ms`
- diagnostics: `raw_payload`, `last_seen_at`, `active`
- timestamps: `created_at`, `updated_at`

### 4.3 Schedule Versioning

#### `channel_schedule_runs`
- Represents one schedule generation attempt/version.

Key fields:
- `channel_service_id`
- `window_start`, `window_end`
- `status` (`pending|running|success|failed|cancelled`)
- `is_active` (only one active successful run per channel)
- `trigger_type` (`auto|manual|recovery`)
- `schedule_type` (planned, e.g. `binge|fixed_slot|marathon|hybrid`)
- `source_feed_id`, `generated_entry_count`, `error_message`
- `started_at`, `completed_at`, `created_at`, `updated_at`

#### `channel_schedule_entries`
- Concrete timeline entries for a run.

Key fields:
- `run_id`, `channel_service_id`, `sequence_no`
- `starts_at`, `ends_at`
- `asset_id`, `asset_type`, `title`
- `season_number`, `episode_number`, `duration_ms`

---

## 5) Ingestion Pipeline

### 5.0 DB -> Ingestion -> Scheduling Flow

```mermaid
flowchart TD
  A[mrss_feeds + channel_mrss_sources configured] --> B[Ingestion trigger: CLI now / poller later]
  B --> C[Fetch MRSS URL]
  C --> D{HTTP result}
  D -->|304| E[No content change]
  D -->|200| F[Parse + normalize items]
  D -->|error| G[Update mrss_feeds fetch error metadata]
  F --> H[Upsert into mrss_assets by (mrss_feed_id, asset_id)]
  E --> I[Find affected channels by mrss_feed_id]
  H --> I
  I --> J[Create channel_schedule_runs row]
  J --> K[Generate binge timeline]
  K --> L[Validate entries]
  L -->|pass| M[Insert channel_schedule_entries]
  M --> N[Activate new run / deactivate previous active run]
  L -->|fail| O[Mark run failed]
  O --> P[Keep previous active schedule]
  G --> P
```

Notes:
- DB `updated_at` triggers only maintain timestamps; they do not run ingest or scheduling logic.
- Feed change detection for same URL is handled by fetch logic (`ETag`, `Last-Modified`, or payload diff fallback), not DB triggers.

### 5.1 Entry
Command: `ingest-mrss`

Inputs:
- `--mrss-feed-id` (required)
- `--db-url` (or `DATABASE_URL`)
- one of:
  - `--feed-url`
  - `--xml-file`

### 5.2 Steps
1. Read XML from URL or local file.
2. Parse XML into canonical `AssetRecord` list.
3. Upsert assets into `mrss_assets`.

### 5.3 Parsing Rules
- Item typing:
  - `<episode>` => `episode`
  - `<slate>` => `slate`
- Asset identity:
  - `episode/assetId` or `slate/assetId`
- Availability:
  - parse `dcterms:valid` into `valid_from`/`valid_to`
- Duration:
  1. Use segmentation last `markOutFrame` / frameRate
  2. fallback to `<duration>`

### 5.4 Current Behavior Notes
- Items missing `asset_id` are skipped.
- Unknown/malformed numeric/date fields resolve to `None` and do not crash the whole feed.
- Missing-item deactivation is not implemented yet (future enhancement).

---

## 6) Scheduling Pipeline

### 6.0 Strategy-Based Scheduling (Scalable Extension Point)

To support multiple schedule types with minimal updates, keep one shared orchestration flow and plug in strategy modules:

- `ScheduleStrategy` interface (planned):
  - `name() -> str`
  - `select_candidates(...)`
  - `build_entries(window_start, window_end, candidates, policy) -> list[ScheduleEntry]`
  - `validate(entries, policy) -> ValidationResult`
- Strategy registry:
  - map `schedule_type` to implementation.
  - default strategy = `binge`.
- Orchestrator responsibilities stay unchanged:
  - create run
  - fetch assets
  - call strategy
  - persist/activate or fail

This keeps future scheduling types isolated to new strategy modules rather than edits across ingestion/repository/runtime code.

### 6.1 Entry
Command: `generate-schedule`

Inputs:
- `--channel-service-id` (required)
- `--db-url` (or `DATABASE_URL`)
- `--window-hours` (default 24)
- `--trigger-type` (`manual|auto|recovery`)
- `--schedule-type` (planned; default `binge`)

### 6.2 Steps
1. Resolve `mrss_feed_id` from `channel_service_id`.
2. Create `channel_schedule_runs` row (`status=running`).
3. Load valid assets from `mrss_assets`.
4. Generate timeline in binge order.
5. Insert `channel_schedule_entries`.
6. Mark previous active run inactive.
7. Mark current run `success` + `is_active=true`.

Failure path:
- Mark run as `failed` with `error_message`.
- Keep previous active schedule unchanged.

### 6.3 Binge Engine Rules (v1)
- Candidate assets split into:
  - `episode_assets`
  - `fallback_slates`
- Episode sort key:
  1. `season_number` (nulls last via sentinel)
  2. `episode_number` (nulls last via sentinel)
  3. `asset_id`
- Fill window by looping ordered episodes.
- If no episodes, fill from slates.
- Each entry duration uses `duration_ms`.

### 6.4 Future Strategy Types (Planned)
- `fixed_slot`: fixed wall-clock slot grid (e.g. top-of-hour programming).
- `marathon`: same series/season repeated with configurable repetition depth.
- `hybrid`: editorial anchors + dynamic fill from catalog.

Shared contract across all types:
- output to `channel_schedule_entries`
- same run lifecycle in `channel_schedule_runs`
- same activation semantics and rollback behavior

---

## 7) Transaction and Consistency Strategy

- Ingestion:
  - Upserts execute within DB transaction; commit once per ingest.
- Scheduling:
  - Run creation + entry insert + activation update occur in one transaction.
  - Failed generation updates run status and commits failure state.
- Activation:
  - Previous active runs are deactivated before activating new run.
  - Guarantees single active run per channel at commit time.

---

## 8) Runtime Interfaces

### 8.1 CLI Commands

Ingestion:
```bash
ingest-mrss \
  --db-url "$DATABASE_URL" \
  --mrss-feed-id "<mrss_feed_uuid>" \
  --xml-file "/path/to/feed.xml"
```

Scheduling:
```bash
generate-schedule \
  --db-url "$DATABASE_URL" \
  --channel-service-id "<channel_service_id>" \
  --window-hours 24 \
  --trigger-type manual
```

### 8.2 Planned REST Endpoints
- `POST /feeds`
- `POST /channels`
- `POST /feeds/{id}/fetch`
- `POST /channels/{id}/schedule/generate`
- `GET /channels/{id}/schedule/active`
- `GET /channels/{id}/runs`

---

## 9) Error Handling and Fallback

Current guarantees:
- Feed fetch/parser failures do not invalidate existing active schedules.
- Generation failure marks run failed and preserves prior active run.
- No generated entries => treated as failure.

Planned hardening:
- retry policy for transient fetch failures
- dead-letter strategy for repeated failures
- alert thresholds for consecutive feed errors

---

## 10) Observability (Planned)

Minimum metrics:
- feed fetch count/success/failure
- parse success/failure
- assets upserted per ingest
- schedule generation duration
- schedule generation success/failure
- active schedule staleness by channel

Minimum logs (structured):
- `mrss_feed_id`
- `channel_service_id`
- `run_id`
- stage name (`fetch|parse|upsert|generate|publish`)
- error category/message

---

## 11) Security and Access

Current:
- DB URL provided via CLI/env var.

Planned:
- secret storage via manager (not plaintext env in prod).
- strict role-based DB user permissions:
  - read/write only required tables
  - no superuser privileges
- authenticated API access for control actions.

---

## 12) Testing Strategy

Unit tests (to add):
- `dcterms:valid` parser edge cases.
- segmentation duration computation with different frame rates.
- episode ordering deterministic behavior.
- fallback slate generation.

Integration tests (to add):
- sample MRSS ingest -> `mrss_assets` row assertions.
- schedule generation -> run + entries + active flag assertions.
- failure simulation -> active schedule unchanged.

---

## 13) Known Gaps / Next Backend Tasks

1. **Validity-per-slot enforcement**
- Current filtering is at schedule start time only.
- Improve to enforce validity at each entry placement time.

2. **Snapshot semantics**
- Add deactivation for assets not present in latest successful feed snapshot.

3. **Validation layer**
- Add explicit checks:
  - contiguous timeline
  - no overlap
  - minimum window coverage

4. **Multi-strategy framework**
- Add `schedule_type` configuration at channel level.
- Introduce strategy registry + interface and move binge logic under `BingeStrategy`.

5. **Worker mode**
- Add automatic due-feed poller and auto generation triggers.

6. **Control API**
- Replace pure CLI operation with service endpoints.

7. **Operational tooling**
- metrics, dashboards, alerts, and runbook automation.

---

## 14) Deployment Guidance

MVP:
- Single process service + CLI jobs + Postgres.

Production target:
- API service + worker service
- managed Postgres
- queue/scheduler orchestration
- centralized logging/monitoring

---

## 15) Document Ownership

Owner: Backend engineering.

Update this document when:
- schema changes
- parsing rules change
- scheduling rules change
- runtime interfaces (CLI/API) change

