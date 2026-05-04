# Automated Binge Scheduler Requirements

## 1. Purpose
Define the requirements for an automated scheduler that ingests MRSS feeds and creates a continuous binge-channel schedule for each configured channel service ID.

## 2. Scope
- In scope:
  - Register channels and MRSS feed URLs.
  - Fetch and parse MRSS XML on a recurring interval.
  - Normalize episodic and slate metadata.
  - Generate and publish versioned binge schedules.
  - Preserve service continuity with fallback behavior.
- Out of scope (MVP):
  - Personalized per-user schedules.
  - Advanced ad decisioning and campaign optimization.
  - Cross-series editorial curation.

## 3. Definitions
- Channel: Logical output stream identified by `channel_service_id`.
- Feed: Shared MRSS URL that can map to multiple channels.
- Asset: Playable unit (`episode` or `slate`) parsed from MRSS.
- Schedule run: One generation attempt for a channel and time window.
- Active schedule: Latest validated run currently used by downstream consumers.

## 4. Stakeholders
- Content Operations: Manage mappings and monitor quality.
- Platform Engineering: Build and run ingestion/scheduling services.
- Downstream Consumer Team: Consume active schedule output.

## 5. Functional Requirements

### FR-1 Feed and Channel Management
1. System must store a mapping from `channel_service_id` to a feed reference.
2. System must allow multiple channels to share one MRSS URL/feed record.
3. System must support enabling/disabling feed polling.
4. System must support configurable polling interval per feed.

### FR-2 Feed Fetching
1. System must poll due feeds automatically.
2. System must use conditional HTTP (`ETag`, `Last-Modified`) when available.
3. System must record fetch attempt metadata:
   - timestamp
   - HTTP status
   - last error (if any)
   - last success time

### FR-3 MRSS Parsing and Normalization
1. System must parse `series`, `season`, and `item` nodes.
2. System must classify each item as `episode` or `slate`.
3. System must parse and store:
   - `asset_id`
   - `series_id`, `season_id`
   - `season_number`, `episode_number` (when present)
   - title/description/rating/genre
   - validity window from `dcterms:valid`
4. System must compute `duration_ms` using:
   - segmentation/frame data when present
   - fallback to `<duration>` for slate or other assets
5. System must tolerate malformed items by dropping invalid items and processing remaining valid items.

### FR-4 Binge Schedule Generation
1. System must generate schedules per channel for a configurable window (default: 24h).
2. System must include only assets valid at scheduling time (`valid_from <= time < valid_to`).
3. System must order episodes by:
   - `season_number` ASC
   - `episode_number` ASC
   - deterministic tie-breaker (`asset_id`)
4. System must loop sequence continuously to fill the entire schedule window.
5. System must support slate insertion policy:
   - optional opening slate
   - fallback slate when no valid episode is available

### FR-5 Validation and Publish
1. System must validate schedule output before activation.
2. Validation must ensure:
   - no overlapping entries
   - each entry has `end_time > start_time`
   - timeline covers target window threshold
3. System must activate new schedules atomically.
4. System must retain previous successful schedule versions for rollback/audit.

### FR-6 Failure Handling
1. On fetch failure, system must keep previous assets and active schedule.
2. On parse failure, system must reject new feed snapshot and keep prior state.
3. On schedule generation failure, system must not activate partial output.
4. On no valid episodes, system must publish or maintain fallback slate schedule based on policy.

### FR-7 Operations and APIs
1. System must provide APIs for:
   - feed/channel registration and updates
   - manual fetch trigger
   - manual schedule generation trigger
   - reading active schedule and run history
2. System must expose run diagnostics for troubleshooting.

## 6. Non-Functional Requirements

### NFR-1 Reliability
- Target scheduler availability: 99.9% (MVP target can be monitored, not contractually enforced).
- No data loss for successful published schedules.
- Idempotent reprocessing of same feed snapshot.

### NFR-2 Performance
- Feed fetch + parse should complete within 60s for typical feed sizes.
- Schedule generation for one channel (24h window) should complete within 10s under normal load.
- API read for active schedule should return within 500ms p95 (excluding downstream dependencies).

### NFR-3 Scalability
- Support many channels sharing few feeds without duplicate fetches.
- Support horizontal worker scaling with locking/idempotency protections.

### NFR-4 Security
- Validate MRSS URLs and restrict unsupported schemes.
- Protect APIs with authentication/authorization (service-level for MVP).
- Avoid exposing sensitive internal errors in public responses.

### NFR-5 Observability
- Structured logs with correlation IDs (feed ID, run ID, channel ID).
- Metrics for fetch success rate, parse failures, generation failures, schedule coverage.
- Alerting for repeated failures and empty valid asset pools.

## 7. Data Requirements
- Required persisted entities:
  - feed metadata and polling state
  - channel-to-feed mapping
  - normalized asset catalog
  - schedule runs (status + diagnostics)
  - schedule entries (versioned timeline)
- Data retention:
  - keep active and historical schedule runs for audit.
  - retention period configurable (recommended default: 90 days for run logs, longer for active schedule history if needed).

## 8. Assumptions
1. MRSS feed provides stable `asset_id` identifiers.
2. `dcterms:valid` is authoritative for availability windows.
3. Downstream systems can consume versioned schedule output.
4. Timezone baseline for scheduling is UTC unless channel-specific timezone is explicitly configured.

## 9. Constraints
1. Upstream feed quality may vary; parser must handle inconsistent timecode formats.
2. Some items may omit optional metadata fields.
3. Network failures and transient HTTP errors are expected and must be retried by policy.

## 10. Acceptance Criteria (MVP)
1. A channel can be registered with a feed and appears in mapping storage.
2. Feed polling runs automatically and updates fetch metadata.
3. Given a valid MRSS with episodes, scheduler produces a 24h ordered binge timeline.
4. Expired assets are excluded from generated schedule.
5. On feed fetch failure, previously active schedule remains active.
6. Run history and diagnostics are queryable via API.
7. Architecture and workflow docs stay aligned with implementation behavior.

## 11. Delivery Milestones
1. M1: Schema + feed/channel registry complete.
2. M2: Ingestion/parser pipeline complete with normalized assets.
3. M3: Binge generation + schedule versioning complete.
4. M4: APIs + observability + fallback/alerting complete.
5. M5: Shadow validation and production readiness sign-off.

