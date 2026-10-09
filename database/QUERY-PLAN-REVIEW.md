# PostgreSQL query-plan review

Use a staging database with representative row counts and distributions. The queries below mirror current service patterns and are starting points; substitute realistic values and current schema names as needed.

`EXPLAIN (ANALYZE, BUFFERS)` executes a query. Use a read-only database role and run against staging by default. Do not run expensive plans against production without a reviewed maintenance window.

## Public content feeds

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, slug, published_at
FROM blog_posts
WHERE published = TRUE AND moderation_status = 'approved'
ORDER BY published_at DESC, created_at DESC
LIMIT 50 OFFSET 0;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, slug, event_date
FROM events
WHERE published = TRUE AND moderation_status = 'approved'
ORDER BY event_date ASC, created_at DESC
LIMIT 50 OFFSET 0;
```

## Published full-text search

Use the exact `to_tsvector` expressions and status predicates in `backend/src/services/contentService.ts`; PostgreSQL expression indexes are only useful when the query expression matches. Check both the blog and event branches with common and rare terms.

## Admin lists and aggregates

Review admin inquiry/subscriber/user lists at first and deep offsets, plus overview `count(*)` queries. Compare actual and estimated rows, buffers, and sort work. If deep offsets or full counts become expensive, evaluate keyset pagination or cached/maintained summaries from measured evidence before changing the API contract.

## Record results

For each reviewed query, record:

- PostgreSQL version and approximate table row counts.
- Query parameters and whether the result is representative.
- Plan node, estimated/actual rows, loops, shared buffer hits/reads, sort method, and execution time.
- Index used or reason for sequential scan; whether that behavior is expected at the measured table size.
- Follow-up action, owner, and remeasurement date.

Do not add an index solely because one plan uses a sequential scan on a small table. Confirm the workload frequency, write cost, selectivity, and production-like plan first.
