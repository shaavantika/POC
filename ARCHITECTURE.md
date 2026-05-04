# Automated Binge Scheduler Architecture

## Goal
Build a resilient scheduling system that ingests MRSS feeds, normalizes episodic metadata, and continuously produces a valid binge-channel schedule per channel service.

## System Context
- Input: MRSS XML feed(s) mapped to channel service IDs.
- Processing: Parse, normalize, filter by rights windows, then schedule.
- Output: Versioned schedule timeline for downstream playout/API consumers.

## High-Level Components

1. Feed Registry
- Stores channel-to-feed mapping and feed-level polling metadata.
- Ensures multiple channels can share one MRSS URL without duplicate fetches.

2. Ingestion Worker
- Polls enabled feeds by interval.
- Uses conditional HTTP (`ETag`, `Last-Modified`) to reduce bandwidth.
- Stores fetch diagnostics and raw feed snapshots for traceability.

3. MRSS Parser + Normalizer
- Parses `series`, `season`, and `item` blocks.
- Classifies assets into types (`episode`, `slate`).
- Converts provider-specific fields into canonical fields:
  - IDs: `asset_id`, `series_id`, `season_id`
  - Ordering: `season_number`, `episode_number`
  - Availability: `valid_from`, `valid_to`
  - Runtime: `duration_ms` (from segmentation or duration tag)

4. Asset Catalog Store
- Upserts normalized assets.
- Tracks active/inactive status and last-seen timestamp by feed.
- Supports rights-time filtering for schedule generation.

5. Binge Scheduling Engine
- Generates deterministic ordered sequence:
  - Group by series/season
  - Sort by season and episode number
  - Filter out invalid/expired assets
- Builds rolling timeline window (e.g., next 24h).
- Applies slate insertion policy (channel start, gap fill, optional hour alignment).

6. Schedule Publisher
- Persists immutable schedule versions.
- Marks one schedule version as active per channel.
- Provides safe fallback to last successful version on failures.

7. Control API / Admin Layer
- Manage mappings and feed controls (`enabled`, intervals).
- Trigger ad-hoc fetch/generate/publish runs.
- Expose run diagnostics and active schedule views.

8. Observability
- Logs by feed and run IDs.
- Metrics: fetch success %, parse failures, generation latency, schedule coverage hours.
- Alerts: repeated fetch failures, empty valid catalog, publish failures.

## Runtime Flow

1. Poller selects due feeds (`enabled=true` and interval elapsed).
2. Ingestion worker fetches feed and records status.
3. If body changed (or first fetch), parser normalizes feed assets.
4. Asset catalog upserts canonical records.
5. Scheduler runs per affected channel(s) referencing that feed.
6. New schedule version is generated and validated.
7. Publisher activates new version atomically.
8. If any step fails, previous active schedule remains in place.

## Data Boundaries

Current migrations:
- `channel_mrss_sources`: channel service mapping.
- `mrss_feeds`: shared feed URL + polling state.

Next schema set (recommended):
- `mrss_assets`: normalized item catalog.
- `channel_schedule_runs`: run-level status and diagnostics.
- `channel_schedule_entries`: time-ordered output timeline (versioned).

## Core Scheduling Rules (Binge Mode v1)
- Include only assets currently inside `valid_from <= now < valid_to`.
- Primary order: `season_number`, then `episode_number`.
- Loop from the beginning when the sequence ends.
- Skip missing/unavailable episodes gracefully.
- Insert slate assets only from configured policy points.
- Guarantee non-empty output: fallback slate block if no episode is valid.

## Failure and Recovery Strategy
- Feed fetch failure: keep last known assets and active schedule.
- Parse failure: reject new snapshot, keep previous snapshot and schedule.
- Empty valid catalog: publish fallback slate schedule and raise alert.
- Partial bad item data: drop invalid item, continue processing other assets.

## Deployment Topology
- Single service with internal workers is enough initially:
  - API process
  - Polling + scheduling worker loop
- Scale path:
  - Split ingest and schedule workers
  - Queue-based processing keyed by `mrss_feed_id`
  - Horizontal scale with idempotent jobs

## MVP Build Order
1. Finalize schema for assets and schedules.
2. Build parser/normalizer against sample feed.
3. Implement due-feed fetch worker with conditional HTTP.
4. Implement binge schedule generation (24h rolling).
5. Persist and activate schedule versions.
6. Add API endpoints + metrics + alerts.

## Non-Goals for MVP
- Multi-region active-active publishing.
- Complex ad decisioning logic.
- Personalized schedules.
- Cross-series editorial blending (keep deterministic binge order first).
