BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS blog_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(240) NOT NULL CHECK (length(trim(title)) > 0),
    slug VARCHAR(260) NOT NULL UNIQUE CHECK (length(trim(slug)) > 0),
    content TEXT NOT NULL CHECK (length(trim(content)) > 0),
    meta_title VARCHAR(240),
    meta_description VARCHAR(320),
    published BOOLEAN NOT NULL DEFAULT FALSE,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (published = TRUE AND published_at IS NOT NULL)
        OR published = FALSE
    )
);

CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(240) NOT NULL CHECK (length(trim(title)) > 0),
    slug VARCHAR(260) NOT NULL UNIQUE CHECK (length(trim(slug)) > 0),
    description TEXT NOT NULL CHECK (length(trim(description)) > 0),
    event_date TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ,
    location VARCHAR(300) NOT NULL CHECK (length(trim(location)) > 0),
    published BOOLEAN NOT NULL DEFAULT FALSE,
    capacity INTEGER,
    registration_url VARCHAR(2048),
    meta_title VARCHAR(240),
    meta_description VARCHAR(320),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (capacity IS NULL OR capacity >= 0),
    CHECK (ends_at IS NULL OR ends_at >= event_date)
);

CREATE TABLE IF NOT EXISTS newsletter_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(320) NOT NULL UNIQUE CHECK (length(trim(email)) > 0),
    status VARCHAR(32) NOT NULL CHECK (status IN ('pending','active','unsubscribed','bounced','complained')),
    source VARCHAR(80),
    consented_at TIMESTAMPTZ NOT NULL,
    confirmed_at TIMESTAMPTZ,
    unsubscribed_at TIMESTAMPTZ,
    confirmation_token_hash VARCHAR(128),
    last_delivery_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (status = 'active' AND confirmed_at IS NOT NULL)
        OR status IN ('pending','unsubscribed','bounced','complained')
    ),
    CHECK (
        (status = 'unsubscribed' AND unsubscribed_at IS NOT NULL)
        OR status IN ('pending','active','bounced','complained')
    )
);

CREATE TABLE IF NOT EXISTS contact_inquiries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL CHECK (length(trim(name)) > 0),
    email VARCHAR(320) NOT NULL CHECK (length(trim(email)) > 0),
    subject VARCHAR(200) NOT NULL CHECK (length(trim(subject)) > 0),
    message VARCHAR(3000) NOT NULL CHECK (length(trim(message)) > 0),
    status VARCHAR(32) NOT NULL CHECK (status IN ('received','triaged','in_progress','resolved','spam')),
    source VARCHAR(80),
    spam_score NUMERIC(5,4) CHECK (spam_score IS NULL OR (spam_score >= 0 AND spam_score <= 1)),
    handled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (status IN ('resolved','spam') AND handled_at IS NOT NULL)
        OR status IN ('received','triaged','in_progress')
    )
);

CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID,
    action VARCHAR(80) NOT NULL CHECK (length(trim(action)) > 0),
    resource_type VARCHAR(80) NOT NULL CHECK (length(trim(resource_type)) > 0),
    resource_id VARCHAR(255),
    metadata JSONB,
    request_id VARCHAR(120),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
