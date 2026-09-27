-- Seed data intentionally minimal and local-only. No production-like or real user data.

INSERT INTO blog_posts (title, slug, content, published, published_at, created_at, updated_at)
SELECT 'Sample Editorial Post', 'sample-editorial-post', 'This is a local development placeholder for a published blog article.', TRUE, now(), now(), now()
WHERE NOT EXISTS (SELECT 1 FROM blog_posts WHERE slug = 'sample-editorial-post');

INSERT INTO events (title, slug, description, event_date, location, published, created_at, updated_at)
SELECT 'Sample Public Event', 'sample-public-event', 'This is a local development placeholder for a scheduled event.', now() + INTERVAL '30 days', 'Kolkata', TRUE, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM events WHERE slug = 'sample-public-event');

INSERT INTO newsletter_subscriptions (email, status, consented_at, confirmed_at, created_at, updated_at)
SELECT 'subscriber@example.com', 'active', now(), now(), now(), now()
WHERE NOT EXISTS (SELECT 1 FROM newsletter_subscriptions WHERE lower(email) = 'subscriber@example.com');

INSERT INTO contact_inquiries (name, email, subject, message, status, created_at, updated_at)
SELECT 'Example Contact', 'contact@example.com', 'Sample inquiry', 'This is a local development placeholder message.', 'received', now(), now()
WHERE NOT EXISTS (SELECT 1 FROM contact_inquiries WHERE email = 'contact@example.com');
