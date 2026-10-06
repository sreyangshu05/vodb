# Database implementation

This directory contains the PostgreSQL migrations, seed data, and schema tests for the backend API.

## Scope

The implemented schema covers only the durable domain evidence documented in the frontend database design package:

- `blog_posts`
- `events`
- `newsletter_subscriptions`
- `contact_inquiries`
- `audit_events`
- `users`
- `protected_media` and `protected_media_access_log`
- `password_reset_otps`
- `reader_email_verification_otps` and verified reader email state
- `media_assets` (PostgreSQL `BYTEA` image data for editorial images)

The database intentionally does not add tenanting, Redis, Elasticsearch, Kafka, search clusters, multi-region replication, or object-storage metadata because the repository evidence does not require them.

## Local setup

Copy the example environment file and adjust values if needed:

```bash
cp .env.example .env
```

Then start the PostgreSQL instance:

```bash
docker compose up -d
```

The migration files under `migrations/` are mounted into `/docker-entrypoint-initdb.d` and are executed automatically on first startup. If you want to apply them manually later, use:

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/001_create_tables.sql

docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/002_create_indexes_triggers.sql

docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/003_create_users.sql
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/004_create_protected_media.sql
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/005_create_password_reset_otps.sql
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/006_add_google_auth.sql
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/007_add_moderation_states.sql
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/008_add_content_query_indexes.sql
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/009_create_media_assets.sql
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/010_add_source_paths_for_site_images.sql
```

For an existing installation that has already applied migrations 001-009, apply migration 010 before importing homepage images. If it is at migration 008, apply both 009 and 010:

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/010_add_source_paths_for_site_images.sql
```

After applying migrations 009 and 010, import the homepage image files in `frontend/images` into PostgreSQL with `npm.cmd --prefix backend run import:homepage-images` in Windows PowerShell (use `npm` from bash). The script reads `backend/config/homepage-image-paths.txt`, uses the backend `.env` PostgreSQL settings, and safely inserts or updates the referenced images. The source files remain available for future re-imports; the production frontend no longer bundles these homepage image imports. The current manifest contains 65 homepage/shared-navigation images, about 143 MiB total.

## Migration model

Migrations are intentionally ordered and plain SQL:

- `migrations/001_create_tables.sql`
- `migrations/002_create_indexes_triggers.sql`
- `migrations/003_create_users.sql`
- `migrations/004_create_protected_media.sql`
- `migrations/005_create_password_reset_otps.sql`
- `migrations/006_add_google_auth.sql`
- `migrations/007_add_moderation_states.sql`
- `migrations/008_add_content_query_indexes.sql`
- `migrations/009_create_media_assets.sql`
- `migrations/010_add_source_paths_for_site_images.sql`
- `migrations/011_create_reader_account_features.sql`
- `migrations/012_add_published_search_indexes.sql`
- `migrations/013_harden_newsletter_action_tokens.sql`
- `migrations/014_require_verified_reader_email.sql`

Homepage image bytes are held in PostgreSQL `BYTEA`. Import requires adequate database storage and backup capacity (about 138 MiB for the current homepage image manifest).

These are designed to be replay-safe on the same database and reviewable in source control. Docker init scripts run automatically only when the database volume is first created. For an existing database, configure `DIRECT_DATABASE_URL` and run the ordered migration runner from the repository root:

```powershell
npm.cmd --prefix backend run db:migrate
```

The runner applies every pending numbered migration and records checksums in `app_schema_migrations`. Use a direct connection URL for migrations; the pooled `DATABASE_URL` is for the running API. Test pending migrations on a Neon branch before applying them to production.

To apply just one migration after confirming its prerequisites are already recorded, pass its exact filename:

```powershell
npm.cmd --prefix backend run db:migrate -- --only 011_create_reader_account_features.sql
```

## Documentation alignment

The implementation follows the design documents in `frontend/docs/database` and preserves the accepted design decisions:

- single managed PostgreSQL primary
- no multi-tenancy for the initial site
- no search/cache/queue infrastructure yet
- no bundle-content migration into the database
- read-heavy public content with low-write subscription/inquiry capture

## Operational notes

- Use UTC timestamps with `timestamptz`.
- Keep all writes behind the API boundary; the browser never connects directly to PostgreSQL.
- Use least-privilege database roles in production.
- Backups and PITR are provider-managed requirements before production.

## Validation

Run the schema smoke tests after startup:

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /tmp/tests/schema_smoke_tests.sql
```

The test script checks for required tables, constraints, lifecycle conditions, uniqueness, and publication filters.

The local PostgreSQL container is published on host port `5433` because port `5432` may already be used by another PostgreSQL installation. The backend local environment must therefore use `POSTGRES_PORT=5433`.

For the current evidence record, see [`docs/database/DATABASE-OPERATIONS-GUIDE.md`](../docs/database/DATABASE-OPERATIONS-GUIDE.md) and [`docs/operations/LOCAL-RESTORE-DRILL-RESULTS.md`](../docs/operations/LOCAL-RESTORE-DRILL-RESULTS.md).
