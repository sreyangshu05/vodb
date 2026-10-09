# Current API Contracts

This document describes only routes verified in `backend/src`. Other endpoint inventories are future design material.

## Health and readiness

- `GET /api/v1/health`: 200, process liveness; no database guarantee.
- `GET /api/v1/readiness`: 200 `{ ok:true, service, database:"ready" }` when `db.healthcheck()` succeeds; 503 `{ ok:false, service, database:"unavailable" }` otherwise.

## Public content

- `GET /api/v1/blogs`: published blog records with bounded `limit`/`offset` pagination and `Cache-Control: no-store`.
- `GET /api/v1/blogs/slug/:slug`: one published blog or 404.
- `GET /api/v1/events`: published event records with bounded `limit`/`offset` pagination and `Cache-Control: no-store`.
- `GET /api/v1/events/slug/:slug`: one published event or 404.
- `GET /api/v1/search?q=&type=&limit=&offset=`: bounded full-text search over published/approved articles and events; returns IDs, titles, internal URLs, groups, short excerpts and total count. `type` is `all`, `articles`, or `events`.

## Public submissions

- `POST /api/v1/newsletter/subscribe`: validated email/source plus optional `website` honeypot; 201 for new/pending subscriptions, generic 202 for honeypot or active duplicate, 422 for invalid payload, 503 for database/SMTP failure.
- `POST /api/v1/newsletter/resend-confirmation`: validated email plus optional honeypot; rate-limited, rotates and sends a token only for a pending subscription, and returns the same generic 202 response for unknown, pending, active, or honeypot addresses. Unsubscribed addresses are not reactivated.
- `POST /api/v1/newsletter/confirm` with `{ "token": "..." }`: validates the lifecycle token and activates the subscription. GET is intentionally unsupported so link scanners cannot mutate state.
- `POST /api/v1/newsletter/unsubscribe` with `{ "token": "..." }`: validates the lifecycle token and marks the subscription unsubscribed. GET is intentionally unsupported so link scanners cannot mutate state.
- `POST /api/v1/newsletter/webhooks/delivery`: accepts signed `delivered`, `bounce`, or `complaint` events and updates subscriber delivery state; requires `X-Newsletter-Signature`.
- `POST /api/v1/contact`: validated name/email/subject/message plus optional `website` honeypot; 201 on insert, 202 with a generic success response when the honeypot is filled, 422 for invalid payload, 503 for database service failure.

## Protected media

- `POST /api/v1/media/:id/access`: requires a valid member JWT and returns a short-lived media token, expiry, and token-free stream URL for the requesting user.
- `GET /api/v1/media/stream`: requires the short-lived token in `X-Media-Access-Token`; resolves it and redirects to the configured protected storage URL without placing the token in the URL.

## Admin

- `POST /api/v1/admin/login`: configured admin credentials; 200 with JWT, 400 for missing fields, 401 for mismatch, 429 when rate limited.
- `GET /api/v1/admin/me`: bearer JWT plus admin role required.
- `GET /api/v1/admin/blogs`: bearer JWT plus admin role required.
- `POST /api/v1/admin/blogs`: validated create payload; bearer JWT plus admin role required.
- `PATCH /api/v1/admin/blogs/:id`: validated partial update with required `If-Match` timestamp; bearer JWT plus admin role required.
- `DELETE /api/v1/admin/blogs/:id`: deletes a blog with required `If-Match` timestamp and records an audit event; bearer JWT plus admin role required.
- `POST /api/v1/admin/blogs/:id/moderation/{submit-review|approve|reject|archive}`: changes moderation state with required `If-Match` timestamp; bearer JWT plus admin role required.
- `GET /api/v1/admin/events`: bearer JWT plus admin role required.
- `POST /api/v1/admin/events`: validated create payload; bearer JWT plus admin role required.
- `PATCH /api/v1/admin/events/:id`: validated partial update with required `If-Match` timestamp; bearer JWT plus admin role required.
- `DELETE /api/v1/admin/events/:id`: deletes an event with required `If-Match` timestamp and records an audit event; bearer JWT plus admin role required.
- `POST /api/v1/admin/events/:id/moderation/{submit-review|approve|reject|archive}`: changes moderation state with required `If-Match` timestamp; bearer JWT plus admin role required.
- `GET /api/v1/admin/inquiries?limit=&offset=&search=&status=`: paginated/filtered masked list with bounded message previews; bearer JWT plus admin role required.
- `GET /api/v1/admin/inquiries/:id`: full inquiry details on demand; records an audit event; bearer JWT plus admin role required.
- `GET /api/v1/admin/subscribers?limit=&offset=&search=&status=` and `GET /api/v1/admin/users?limit=&offset=&search=&status=`: paginated/filtered lists with masked email addresses; bearer JWT plus admin role required.
- `PATCH /api/v1/admin/inquiries/:id`: changes inquiry status; records an audit event; bearer JWT plus admin role required.
- `POST /api/v1/admin/ai/editorial-suggestions`: admin-only, rate-limited draft suggestions for SEO title, description, and topic tags; never publishes or saves automatically. Gateway must be configured; editors review and save manually.

## User authentication

- `POST /api/v1/auth/register`: creates a member account using a validated name, email, and password; starts email verification and returns 202 without a JWT. Email verification is completed through `/verify-email`.
- `POST /api/v1/auth/verify-email`: validates the address and six-digit code; returns 200 with a JWT and public user profile.
- `POST /api/v1/auth/resend-verification`: sends a replacement code when an unverified account is eligible; returns a generic 202 response to avoid account enumeration.
- `POST /api/v1/auth/login`: authenticates a member account; returns 200 with a JWT and public user profile.
- `POST /api/v1/auth/google`: verifies a Google ID token against the configured client ID, links or creates a member account using the verified email, and returns the application JWT and public user profile.
- `POST /api/v1/auth/forgot-password`: creates a short-lived, hashed OTP and sends it through configured SMTP; returns a generic 202 response to avoid account enumeration.
- `POST /api/v1/auth/reset-password`: atomically consumes a valid six-digit OTP and updates the member password.
- `GET /api/v1/auth/me`: returns the authenticated profile and reader topic preferences for a valid bearer JWT.
- `PATCH /api/v1/auth/me`: updates the reader display name and returns a replacement JWT/profile.
- `PATCH /api/v1/auth/me/preferences`: saves up to ten supported reader topics.
- `GET|POST|DELETE /api/v1/auth/me/saved-pages`: lists, saves, or removes same-origin local paths owned by the authenticated reader. The GET route returns `{ items, nextCursor, hasMore }`, defaults to 50 items, caps `limit` at 100, and accepts the opaque `nextCursor` for keyset pagination.
- `DELETE /api/v1/auth/me`: deletes a reader `member` account only when the body contains `{ "confirmation": "DELETE" }`; editor/admin identities are rejected. Newsletter subscriptions and contact inquiries remain separate records.

Passwords are stored as Argon2id hashes; legacy scrypt hashes remain readable for migration compatibility. Google identity subjects and password-reset OTP hashes are stored server-side. The API never returns password material or OTP values.

The current database migration chain includes `001` through `021`; apply all ordered migrations before deploying backend code that depends on the latest schema.

## Error contract

```json
{
  "error": "stable_error_code",
  "message": "safe human-readable message",
  "details": {}
}
```

Request IDs are returned in `X-Request-Id`. Clients must not retry non-idempotent POST requests automatically. The API is versioned at `/api/v1`; breaking changes require a new version or compatibility plan.

Saved-page list consumers must follow `nextCursor` while `hasMore` is true. Older clients that read only `items` continue to receive a valid response, but will see only the first page when an account has more than 50 saved pages.

Route-specific error codes are retained for compatibility. Validation errors use HTTP 422 and a safe `{ error, message, details }` shape; unexpected errors return a generic HTTP 500 response. PostgreSQL statement timeouts return 503 with `database_query_timeout`. JSON bodies are capped at 1 MiB, except authenticated image upload bodies, which have a 7 MiB parser cap and additional decoded-image limits. PostgreSQL statements have a configurable 15-second default timeout (`DATABASE_STATEMENT_TIMEOUT_MS`).

`GET /api/v1/blogs` and `/events` accept `limit` (1–100, default 50) and `offset` (0–1,000,000, default 0). Search accepts `limit` (1–50, default 20) and `offset` (0–100,000, default 0). Admin list routes use bounded limit/offset pagination (limit 1–100; endpoint defaults are documented in code). Malformed pagination returns 422 and does not reach the database.

Sensitive submission/authentication endpoints are rate-limited. Shared PostgreSQL buckets are used where configured; public reads and Google verification use process-local buckets. Contact accepts an optional UUID `Idempotency-Key`; same key and same normalized request replay the prior result, while key reuse with different content returns 409. No other POST has a general idempotency guarantee. Newsletter token actions are single-use state transitions; delivery webhook duplicate events are state-idempotent but do not have provider event-ID deduplication.

For route-by-route request/response, authorization, status, pagination, and test coverage, see [Endpoint contracts](./endpoint-contracts.md).

## Not current contracts

Site bootstrap, consultation, donation, payment webhook, and generic auth endpoint documents are not backed by current routes and remain conditional/future. AI endpoints require explicitly configured server-side gateway credentials; search remains useful without them.
