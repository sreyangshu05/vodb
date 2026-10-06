# Backend Final Audit Report

## Executive Summary
The backend implementation has been hardened and aligned to the actual editorial product domain. It now exposes the public API contract, enforces authentication for the admin surface, uses structured validation, and returns honest 503 responses when the database layer is unavailable instead of fake success payloads.

## Status
- Build status: Passed
- Smoke test status: Passed
- Production readiness: Conditional on a valid PostgreSQL environment

## What Was Implemented
- Public content endpoints for blogs and events with slug lookups
- Admin login flow with JWT issuance and protected admin routes
- Input validation with Zod for newsletter, contact, blog, and event payloads
- Rate limiting for public and admin traffic
- Security posture with CORS, Helmet headers, and request ID middleware
- Structured AppError handling and consistent API error responses

## Key Fixes Applied
1. Removed fake success behavior when the database was down.
2. Corrected database outage detection to include actual PostgreSQL auth/connection failures.
3. Normalized route-level error forwarding so service errors keep their specific error codes.
4. Updated smoke tests to assert the truthful behavior under outage conditions.

## Files Reviewed and Updated
- [backend/src/routes/public.ts](backend/src/routes/public.ts)
- [backend/src/services/contentService.ts](backend/src/services/contentService.ts)
- [backend/src/services/submissionService.ts](backend/src/services/submissionService.ts)
- [backend/src/test/api.smoke.test.ts](backend/src/test/api.smoke.test.ts)

## Validation Evidence
I verified with the backend suite:

- Command: npm run build && npm test
- Result: 6 tests passed, 0 failed

The current environment does not have a working PostgreSQL connection because the configured credentials are rejected by the database. The backend is correctly surfacing that as a 503 service unavailable condition for database-backed public operations.

## Production Caveat
The application is not yet fully database-validated against a live Postgres instance because the local database credentials in this environment are invalid. Once the database is configured with the expected credentials and schema is applied, the service should be re-tested against live writes and reads.

## Final Assessment
The backend is in a sound implementation state for a modular monolith serving a content/publication platform. The remaining blocker is environmental configuration, not code-level API design or application logic.

## SRE Performance and Observability Review

### Query and data handling
- No application-side N+1 query pattern was found in the reviewed database call sites. The admin overview issues independent aggregate queries concurrently with `Promise.all`; published content and admin list endpoints use bounded pagination.
- The public blog list previously selected `b.*`, transferring full `TEXT` article bodies for up to 50 cards although the frontend uses only an excerpt and reading-time estimate. It now selects the list fields, returns at most 320 characters in `content`, and calculates an approximate read time in SQL. The slug detail endpoint still returns the full body.
- Admin blog and event lists still use `SELECT *` with a maximum page size of 100. Replace with explicit field lists if the editor UI does not need every column; review media payload and audit metadata sizes before increasing limits.
- Published search uses a single SQL query and has GIN expression indexes in migration 012. `content-review-queue` is also one SQL statement (with a lateral aggregate), not application-level N+1 round trips; profile it with production query statistics before changing it.
- Saved-page listing is not paginated. If per-user collections grow, introduce cursor pagination and update the account client before the table becomes large.
- Argon2id password verification uses native asynchronous hashing but is memory-intensive (64 MiB per operation with the current settings). Track event-loop delay and process memory under login/reset load, and bound concurrent hashing if load tests show memory pressure.

### Logging and key health metrics
- The backend logger emits structured JSON records in production. Request completion and error events now include request ID, route, and authenticated user ID where available; password-reset and newsletter resend delivery warnings also include request IDs without logging addresses or tokens.
- The three primary service indicators are API p95/p99 latency and HTTP error rates; PostgreSQL query p95/p99 latency, failures, and pool waiters; and process saturation via event-loop delay, CPU, and heap/RSS. These are already captured in the metrics snapshot. Readiness probes database connectivity separately.
- Metrics are process-local snapshots, not durable time series. Export them to a shared system such as OpenTelemetry/Prometheus or a hosted metrics service before using them for multi-instance SLOs or alerts.
- Endpoint metrics normalize slug paths and cap the number of distinct endpoint dimensions, preventing arbitrary URLs from growing the per-process maps indefinitely.

### Horizontal scaling caveats
- The in-memory rate limiter is instance-local. With multiple replicas, clients can multiply their effective rate limits by spreading requests across instances. Move security-sensitive limits (login, signup, OTP, contact/newsletter) to a shared Redis/Postgres-backed limiter or enforce them at a shared gateway.
- Metrics, audit retry counters, pending audit write counts, and SSE subscriber sets are also process-local. Persist/export operational telemetry centrally; database audit events themselves are stored in PostgreSQL.
- No request/session state is kept in an in-process session store; authentication is stateless JWT-based. The PostgreSQL pool is per process and currently capped at 20 connections, so size the replica count and pool limits together with the database connection budget.

### Evidence limits and follow-up
- No production `pg_stat_statements` data or representative live database workload was available for this source review. Use those statistics and query plans to rank real bottlenecks, then verify changes against a production-like dataset.
- Backend build passed and the smoke/TLS suite passed (27/27). The standalone runtime-plan replay could not complete because its npm setup encountered Windows `EPERM` unlink errors on native Sharp/Argon2 files; restoring the existing dependencies allowed the direct build and test commands to pass. The database migration state and behavior should still be checked in a disposable branch before production rollout.

## Database Backup and PITR Automation

- The earlier AWS S3/GitHub Actions workflow and 7-day Neon history recommendation were removed after the owner clarified that no paid services are acceptable. No AWS resources were provisioned and no paid workflow was activated.
- Added a local Windows Task Scheduler backup option: [backup-database.ps1](scripts/backup-database.ps1) writes daily PostgreSQL 18 custom-format dumps and SHA-256 checksums to `%LOCALAPPDATA%`, retaining seven days. [register-database-backup-task.ps1](scripts/register-database-backup-task.ps1) registers the task for the current logged-in Windows user.
- Added [restore-test-database.ps1](scripts/restore-test-database.ps1), which verifies the checksum, restores into a temporary local database, runs the schema smoke tests, and drops the test database. The local PostgreSQL server/client and successful task setup remain operator prerequisites.
- Current Neon documentation lists the Free plan with 5 GB/month public transfer and a 1 GB database storage allowance; daily full dumps consume public transfer. The Free plan comparison does not include Instant Restore. Do not exceed plan allowances or assume longer PITR. This no-subscription approach keeps backups on one device and does not provide off-device recovery.
- Setup, cost/transfer caveats, and restore steps are documented in [docs/operations/BACKUP-RESTORE-CHECKLIST.md](../docs/operations/BACKUP-RESTORE-CHECKLIST.md). This is local automation, not a claimed production cloud backup or verified PITR configuration.

## Authentication Security Review Follow-up

- The shared six-digit OTP hash was previously an unkeyed SHA-256 digest, allowing offline enumeration if the OTP table were read. Both email-verification and password-reset codes are now stored as HMAC-SHA-256 digests using a dedicated `OTP_HASH_SECRET`, required to be a separate random value of at least 32 characters in production.
- Configure `OTP_HASH_SECRET` in the production secret store before deploying. Existing outstanding OTPs hashed with the old scheme will no longer validate after rollout; users must request a new code. No schema migration is required.
- Authentication SQL queries inspected for this review use parameterized values. OTP attempt caps/lockouts and auth route rate limiting are already present; the in-memory rate limiter remains per-instance, as noted in the horizontal-scaling caveats above.
