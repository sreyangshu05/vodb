# Implementation gaps

## BLOCKING

- No real backend repository is present in this workspace, so production runtime roles, migration credentials, and API wiring are not implemented here.
- Provider-level backup and PITR configuration must be enabled outside the repository.

## IMPORTANT

- The frontend forms remain simulated; a backend contract is still required for live subscription and inquiry operations.
- Editorial admin workflow and audit retention policy are still pending approval.

## NON-BLOCKING

- The sample seed data is intentionally minimal and local-only.
- The optional `audit_events` table is included to support future admin mutation tracking but is not active without an admin workflow.

## DOCUMENTATION GAP

- The repo does not yet include a backend service or deployment manifest to attach the database implementation to real runtime credentials.
- Legal retention requirements for contact/newsletter data remain unspecified.

## SCALE-TRIGGERED

- Read replica, read routing, partitioning, and large-volume reporting are intentionally deferred.
- Redis, search cluster, queue integration, and object storage are not implemented because documented triggers do not exist.
