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
  ASSERT (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'newsletter_delivery_webhook_events')), 'newsletter_delivery_webhook_events table missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'blog_posts' AND column_name = 'moderation_status')), 'blog_posts.moderation_status column missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'moderation_status')), 'events.moderation_status column missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'all_day')), 'events.all_day column missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'token_version')), 'users.token_version column missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contact_inquiries' AND column_name = 'idempotency_key')), 'contact_inquiries.idempotency_key column missing';
END $$;

DO $$
BEGIN
  ASSERT (EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'blog_posts' AND indexdef LIKE 'CREATE UNIQUE INDEX% (slug)')), 'Blog slug uniqueness is not enforced';
  ASSERT (EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'events' AND indexdef LIKE 'CREATE UNIQUE INDEX% (slug)')), 'Event slug uniqueness is not enforced';
  ASSERT (NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname IN ('uq_blog_posts_slug', 'uq_events_slug')), 'Redundant slug index remains';
  ASSERT (EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_newsletter_email')), 'Missing newsletter email unique index';
  ASSERT (EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_users_email_lower')), 'Missing case-insensitive user email unique index';
  ASSERT (EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_users_google_subject')), 'Missing Google subject unique index';
  ASSERT (EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'protected_media_access_log_retention_idx')), 'Missing media access retention index';
  ASSERT (EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'newsletter_delivery_webhook_events' AND indexname = 'newsletter_delivery_webhook_events_pkey')), 'Newsletter webhook event IDs must be unique';
END $$;

DO $$
BEGIN
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'auth_provider')), 'users.auth_provider column missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'google_subject')), 'users.google_subject column missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'password_reset_otps' AND column_name = 'code_hash')), 'password_reset_otps.code_hash column missing';
  ASSERT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_events' AND column_name = 'legal_hold' AND is_nullable = 'NO'), 'audit_events.legal_hold column missing or nullable';
END $$;

DO $$
BEGIN
  INSERT INTO blog_posts (title, slug, content, published) VALUES ('Unique test', 'unique-test-slug', 'Body', FALSE);
  INSERT INTO events (title, slug, description, event_date, location, published)
  VALUES ('Unique test', 'unique-test-event', 'Body', now(), 'Kolkata', FALSE);
  INSERT INTO newsletter_subscriptions (email, status, consented_at, confirmed_at)
  VALUES ('unique-test@example.com', 'active', now(), now());
  INSERT INTO users (name, email, password_hash) VALUES ('Unique Test', 'unique-user@example.com', 'test');

  BEGIN
    INSERT INTO blog_posts (title, slug, content, published) VALUES ('Duplicate slug test', 'unique-test-slug', 'Body', FALSE);
    RAISE EXCEPTION 'Duplicate blog slug was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO events (title, slug, description, event_date, location, published)
    VALUES ('Duplicate event slug test', 'unique-test-event', 'Body', now(), 'Kolkata', FALSE);
    RAISE EXCEPTION 'Duplicate event slug was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO newsletter_subscriptions (email, status, consented_at, confirmed_at)
    VALUES ('UNIQUE-TEST@example.com', 'active', now(), now());
    RAISE EXCEPTION 'Case-insensitive duplicate newsletter email was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO users (name, email, password_hash) VALUES ('Duplicate User', 'UNIQUE-USER@example.com', 'test');
    RAISE EXCEPTION 'Case-insensitive duplicate user email was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  DELETE FROM blog_posts WHERE slug = 'unique-test-slug';
  DELETE FROM events WHERE slug = 'unique-test-event';
  DELETE FROM newsletter_subscriptions WHERE lower(email) = 'unique-test@example.com';
  DELETE FROM users WHERE lower(email) = 'unique-user@example.com';
END $$;

DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  test_media_id UUID;
BEGIN
  INSERT INTO users (id, name, email, password_hash)
  VALUES (test_user_id, 'Foreign Key Test', 'foreign-key-test@example.com', 'test');
  INSERT INTO user_saved_pages (user_id, page_path, title)
  VALUES (test_user_id, '/foreign-key-test', 'Foreign key test');
  INSERT INTO protected_media (owner_user_id, title, storage_url, mime_type)
  VALUES (test_user_id, 'Foreign key test', 'https://example.com/test.png', 'image/png')
  RETURNING id INTO test_media_id;

  DELETE FROM users WHERE id = test_user_id;

  ASSERT NOT EXISTS (SELECT 1 FROM user_saved_pages WHERE user_id = test_user_id), 'User-owned saved pages did not cascade on user deletion';
  ASSERT (SELECT owner_user_id IS NULL AND is_shared = FALSE FROM protected_media WHERE id = test_media_id), 'Protected media ownership did not become unowned and private';

  DELETE FROM protected_media WHERE id = test_media_id;
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
