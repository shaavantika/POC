# Backend Implementation Checklist

This checklist tracks backend delivery for the automated binge scheduler.
Use it with `BACKEND.md`, `ARCHITECTURE.md`, and `WORKFLOW.md`.

## Phase 0 - Foundation

- [x] Create initial schema for channel/feed mapping.
- [x] Add shared feed table with fetch metadata.
- [x] Add normalized asset and schedule tables.
- [x] Write architecture and workflow documentation.
- [x] Write backend technical document.

Done criteria:
- SQL migrations are present and reviewed.
- Local DB can apply migrations in order (001 -> 003).

## Phase 1 - Ingestion MVP

- [x] Add ingestion CLI entrypoint.
- [x] Add MRSS fetcher utility.
- [x] Add parser for episode/slate extraction.
- [x] Parse `dcterms:valid` into canonical timestamps.
- [x] Derive `duration_ms` from segmentation with fallback to `<duration>`.
- [x] Upsert normalized assets into `mrss_assets`.
- [ ] Add ingest logging with feed correlation IDs.
- [ ] Add unit tests for parser edge cases.

Done criteria:
- Running `ingest-mrss` inserts/updates expected assets for sample XML.
- Parser handles malformed items without crashing whole feed.

## Phase 2 - Schedule MVP

- [x] Add schedule generation CLI entrypoint.
- [x] Create run row (`channel_schedule_runs`) lifecycle.
- [x] Load valid assets from `mrss_assets`.
- [x] Implement deterministic binge ordering (season/episode/asset_id).
- [x] Loop timeline to fill window.
- [x] Insert schedule entries and activate run.
- [x] Mark failures and preserve prior active schedule.
- [x] Introduce scheduler strategy interface (`ScheduleStrategy`) with binge as first implementation.
- [x] Add timeline validation (coverage/no-overlap checks).
- [x] Add validity check per entry time slot (not only at window start).
- [ ] Add integration tests for run + entries + active state transitions.

Done criteria:
- `generate-schedule` produces active run and entries for a configured channel.
- Failure path does not replace current active schedule.

## Phase 3 - Data Hardening

- [ ] Add schedule type configuration with backward-compatible default (`binge`).
- [ ] Implement snapshot semantics:
  - mark assets not seen in latest successful feed as inactive (or stale).
- [ ] Add indexes tuned by production query patterns.
- [ ] Add DB constraints for one active run per channel via partial unique index.
- [ ] Add retention job for old runs/entries (configurable policy).
- [ ] Add migration rollback/testing strategy documentation.

Done criteria:
- Feed removals are reflected safely in catalog lifecycle.
- Historical growth remains bounded by retention policy.

## Phase 4 - Worker Automation

- [ ] Add poller job to pick due feeds by interval.
- [ ] Add row locking strategy (`FOR UPDATE SKIP LOCKED`) for feed processing.
- [ ] Update `mrss_feeds` fetch metadata on each attempt.
- [ ] Trigger schedule generation for affected channels automatically.
- [ ] Add configurable retry/backoff for transient fetch failures.

Done criteria:
- System runs continuously without manual CLI for normal operations.
- No duplicate processing for same feed across concurrent workers.

## Phase 5 - Control API

- [ ] Implement feed management endpoints.
- [ ] Implement channel mapping endpoints.
- [ ] Implement manual fetch/generate trigger endpoints.
- [ ] Implement active schedule and run history read endpoints.
- [ ] Add request validation and auth for control operations.

Done criteria:
- Operators can manage and run backend via API only.
- API contract documented with example requests/responses.

## Phase 6 - Observability and Ops

- [ ] Add structured logs for all pipeline stages.
- [ ] Add metrics:
  - fetch success/failure
  - parse success/failure
  - generation success/failure
  - generation duration
  - active schedule staleness
- [ ] Add alerting thresholds for repeated feed failures.
- [ ] Create on-call runbook for ingest/generation incidents.

Done criteria:
- Alerts trigger on real failure simulations.
- Operators can diagnose issues from logs/metrics quickly.

## Phase 7 - Production Readiness

- [ ] Load test with realistic feed/channel counts.
- [ ] Add idempotency and concurrency tests.
- [ ] Add disaster recovery checks (backup/restore verification).
- [ ] Validate secure secret management and least-privilege DB roles.
- [ ] Run shadow mode before live activation.

Done criteria:
- Service meets reliability/performance targets from requirements.
- Go-live checklist signed by engineering and operations.

---

## Immediate Next Tasks (Recommended Sprint)

1. Add parser unit tests using current sample XML.
2. Add parser unit tests for malformed date/duration edge cases.
3. Add ingest and schedule structured logging.
4. Add partial unique index for single active run per channel.
5. Implement snapshot semantics to deactivate missing assets.

