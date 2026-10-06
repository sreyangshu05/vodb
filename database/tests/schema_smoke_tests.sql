-- Smoke tests for required schema, constraints, and key behavior.

DO $$
BEGIN
  ASSERT (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'blog_posts')), 'blog_posts table missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'events')), 'events table missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'newsletter_subscriptions')), 'newsletter_subscriptions table missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'contact_inquiries')), 'contact_inquiries table missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_events')), 'audit_events table missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users')), 'users table missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'protected_media')), 'protected_media table missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'protected_media_access_log')), 'protected_media_access_log table missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'media_assets')), 'media_assets table missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'media_assets' AND column_name = 'source_path')), 'media_assets.source_path column missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'password_reset_otps')), 'password_reset_otps table missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'rate_limit_buckets')), 'rate_limit_buckets table missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'blog_posts' AND column_name = 'moderation_status')), 'blog_posts.moderation_status column missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'moderation_status')), 'events.moderation_status column missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'all_day')), 'events.all_day column missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'token_version')), 'users.token_version column missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contact_inquiries' AND column_name = 'idempotency_key')), 'contact_inquiries.idempotency_key column missing';
END $$;

DO $$
BEGIN
  ASSERT (EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_blog_posts_slug')), 'Missing blog slug unique index';
  ASSERT (EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_events_slug')), 'Missing event slug unique index';
  ASSERT (EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_newsletter_email')), 'Missing newsletter email unique index';
  ASSERT (EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_users_google_subject')), 'Missing Google subject unique index';
END $$;

DO $$
BEGIN
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'auth_provider')), 'users.auth_provider column missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'google_subject')), 'users.google_subject column missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'password_reset_otps' AND column_name = 'code_hash')), 'password_reset_otps.code_hash column missing';
END $$;

INSERT INTO blog_posts (title, slug, content, published, published_at)
VALUES ('First Test Post', 'first-test-post', 'Body', TRUE, now())
ON CONFLICT (slug) DO NOTHING;

INSERT INTO blog_posts (title, slug, content, published)
VALUES ('Draft Post', 'draft-post', 'Draft body', FALSE)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO events (title, slug, description, event_date, location, published)
VALUES ('Example Event', 'example-event', 'Body', now() + INTERVAL '7 days', 'Kolkata', TRUE)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO newsletter_subscriptions (email, status, consented_at, confirmed_at)
VALUES ('alpha@example.com', 'active', now(), now())
ON CONFLICT (lower(email)) DO NOTHING;

INSERT INTO contact_inquiries (name, email, subject, message, status)
VALUES ('Sample', 'sample@example.com', 'Need help', 'Please contact me.', 'received');

DO $$
BEGIN
  ASSERT EXISTS (SELECT 1 FROM blog_posts WHERE slug = 'first-test-post'), 'Published blog not created';
  ASSERT EXISTS (SELECT 1 FROM events WHERE slug = 'example-event'), 'Published event not created';
  ASSERT EXISTS (SELECT 1 FROM newsletter_subscriptions WHERE lower(email) = 'alpha@example.com'), 'Newsletter subscription not created';
  ASSERT EXISTS (SELECT 1 FROM contact_inquiries WHERE email = 'sample@example.com'), 'Inquiry not created';
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM blog_posts WHERE slug = 'sample-editorial-post') THEN
    RAISE NOTICE 'seed data present';
  END IF;
END $$;
