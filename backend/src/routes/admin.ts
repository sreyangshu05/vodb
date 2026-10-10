import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { blogPayloadSchema, blogUpdateSchema, eventPayloadSchema, eventUpdateSchema } from '../lib/validators.js';
import { AppError } from '../utils/errors.js';
import { db } from '../lib/db.js';
import { signToken, getMockAdminUser, verifyAdminPassword } from '../services/authService.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { env } from '../config/env.js';
import { recordAuditEvent } from '../services/auditService.js';
import { metrics } from '../services/metricsService.js';
import { suggestEditorialMetadata } from '../services/knowledgeService.js';

const router = Router();

const loginLimiter = createRateLimiter({
  windowMs: env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS,
  max: env.ADMIN_LOGIN_RATE_LIMIT_MAX_REQUESTS * 6,
  identityMax: env.ADMIN_LOGIN_RATE_LIMIT_MAX_REQUESTS,
  shared: true,
  keyPrefix: 'admin-login',
  identity: (req) => typeof req.body?.email === 'string' ? req.body.email : undefined,
  message: 'Too many admin login attempts. Please retry later.',
});
const adminIpLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  shared: false,
  keyPrefix: 'admin-api-ip',
  message: 'Too many administrative requests. Please wait before trying again.',
});
const adminApiLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 300,
  identityMax: 300,
  shared: true,
  keyPrefix: 'admin-api',
  identity: (req) => req.user?.id,
  message: 'Too many administrative requests. Please wait before trying again.',
});
const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
const searchSchema = z.string().trim().max(120).default('');
const auditQuerySchema = paginationSchema.extend({
  action: z.string().trim().max(80).optional(),
  resourceType: z.string().trim().max(80).optional(),
});
const inquiryStatusSchema = z.enum(['received', 'triaged', 'in_progress', 'resolved', 'spam']);
const subscriberStatusSchema = z.enum(['pending', 'active', 'unsubscribed', 'bounced', 'complained']);
const inquiryListSchema = paginationSchema.extend({ search: searchSchema, status: inquiryStatusSchema.or(z.literal('all')).default('all') });
const subscriberListSchema = paginationSchema.extend({ search: searchSchema, status: subscriberStatusSchema.or(z.literal('all')).default('all') });
const userListSchema = paginationSchema.extend({ search: searchSchema, status: z.enum(['member', 'editor', 'admin', 'all']).default('all') });
const editorialAssistSchema = z.object({
  kind: z.enum(['blog', 'event']),
  title: z.string().trim().min(1).max(240),
  content: z.string().trim().min(1).max(12000),
  imageDescription: z.string().trim().max(1000).optional(),
});
const editorialAssistLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  identityMax: 10,
  shared: true,
  keyPrefix: 'editorial-assist',
  identity: (req) => req.user?.id,
  message: 'Too many AI assistance requests. Please wait before trying again.',
});
const contentReviewWindowSchema = z.object({ days: z.coerce.number().int().min(30).max(3650).default(180) });

async function databaseSnapshot() {
  try {
    await db.healthcheck();
    return { status: 'ready', pool: db.poolStats() };
  } catch {
    return { status: 'unavailable', pool: db.poolStats() };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === '23505';
}

function isConstraintViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === '23514';
}

function requireVersion(req: Request) {
  const header = req.get('if-match');
  const version = header?.replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!version) throw new AppError(428, 'precondition_required', 'If-Match must contain the record version.');
  return version;
}

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');

    if (!email || !password) {
      throw new AppError(400, 'invalid_credentials', 'Email and password are required.');
    }

    const allowedAdminEmails = [env.ADMIN_EMAIL, ...env.ADMIN_EMAILS.split(',')]
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean);
    if (!allowedAdminEmails.includes(email.toLowerCase()) || !(await verifyAdminPassword(password))) {
      throw new AppError(401, 'invalid_credentials', 'Invalid admin credentials.');
    }

    const user = getMockAdminUser(email.toLowerCase());
    const token = await signToken(user);
    void recordAuditEvent({
      action: 'admin.login',
      resourceType: 'admin_session',
      resourceId: user.id,
      metadata: { email: user.email },
      requestId: req.headers['x-request-id'] as string | undefined,
    });
    res.json({ token, user });
  } catch (error) {
    if (error instanceof AppError) {
      return next(error);
    }
    next(error);
  }
});

router.use(adminIpLimiter, requireAuth, requireAdmin, adminApiLimiter);

router.post('/ai/editorial-suggestions', editorialAssistLimiter, async (req, res, next) => {
  try {
    const payload = editorialAssistSchema.parse(req.body ?? {});
    res.json(await suggestEditorialMetadata(payload));
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_editorial_assist_request', 'A title and content draft are required.'));
    next(new AppError(503, 'ai_assistance_unavailable', 'AI suggestions are unavailable. Continue editing manually.'));
  }
});

router.get('/content-review-queue', async (req, res, next) => {
  try {
    const { days } = contentReviewWindowSchema.parse(req.query);
    const result = await db.query(`
      WITH published_content AS (
        SELECT 'blogs'::text AS resource, 'blog_post'::text AS resource_type,
          id, title, slug, updated_at
        FROM blog_posts
        WHERE published = TRUE AND moderation_status = 'approved'
        UNION ALL
        SELECT 'events'::text AS resource, 'event'::text AS resource_type,
          id, title, slug, updated_at
        FROM events
        WHERE published = TRUE AND moderation_status = 'approved'
      ), review_history AS (
        SELECT content.resource_type, content.id::text AS resource_id,
          MAX(audit.occurred_at) AS last_reviewed_at
        FROM published_content content
        JOIN audit_events audit
          ON audit.resource_type = content.resource_type
         AND audit.resource_id = content.id::text
         AND audit.action = 'admin.content.review'
        GROUP BY content.resource_type, content.id
      ), review_state AS (
        SELECT content.resource, content.resource_type, content.id, content.title, content.slug,
          content.updated_at, review.last_reviewed_at,
          GREATEST(content.updated_at, COALESCE(review.last_reviewed_at, content.updated_at)) AS reviewed_or_edited_at
        FROM published_content content
        LEFT JOIN review_history review
          ON review.resource_type = content.resource_type
         AND review.resource_id = content.id::text
      )
      SELECT resource, id::text AS id, title, slug, updated_at, last_reviewed_at,
        reviewed_or_edited_at AS last_reviewed_or_edited_at,
        FLOOR(EXTRACT(EPOCH FROM (NOW() - reviewed_or_edited_at)) / 86400)::integer AS days_since_review
      FROM review_state
      WHERE reviewed_or_edited_at < NOW() - ($1::double precision * INTERVAL '1 day')
      ORDER BY reviewed_or_edited_at ASC, title ASC
      LIMIT 200
    `, [days]);
    res.json({ items: result.rows, days, limit: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_review_window', 'Review age must be between 30 and 3650 days.'));
    next(error);
  }
});

router.post('/content-review/:resource/:id', async (req, res, next) => {
  try {
    const resource = z.enum(['blogs', 'events']).parse(req.params.resource);
    const id = z.string().uuid().parse(req.params.id);
    const table = resource === 'blogs' ? 'blog_posts' : 'events';
    const resourceType = resource === 'blogs' ? 'blog_post' : 'event';
    const exists = await db.query(`SELECT 1 FROM ${table} WHERE id = $1 AND published = TRUE AND moderation_status = 'approved'`, [id]);
    if (!exists.rows[0]) throw new AppError(404, 'published_content_not_found', 'Published content not found.');
    const actorId = req.user?.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.user.id)
      ? req.user.id
      : null;
    const review = await db.query<{ occurred_at: string }>(
      `INSERT INTO audit_events (actor_id, action, resource_type, resource_id, metadata, request_id)
       VALUES ($1, 'admin.content.review', $2, $3, $4, $5)
       RETURNING occurred_at`,
      [actorId, resourceType, id, { source: 'freshness_queue' }, req.headers['x-request-id'] as string | undefined],
    );
    res.status(201).json({ reviewedAt: review.rows[0]?.occurred_at });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_content_review', 'Content type or id is invalid.'));
    next(error);
  }
});

async function assertMediaExists(id: string | null | undefined) {
  if (!id) return;
  const result = await db.query('SELECT 1 FROM media_assets WHERE id = $1', [id]);
  if (!result.rows[0]) throw new AppError(422, 'invalid_media_reference', 'The selected image does not exist.');
}

router.get('/me', (req, res) => {
  res.json({ user: req.user });
});

router.get('/overview', async (_req, res, next) => {
  try {
    const { rows } = await db.query<{
      blogs: string;
      events: string;
      pending_blogs: string;
      pending_events: string;
      open_inquiries: string;
      active_subscribers: string;
      users: string;
    }>(`SELECT
      (SELECT count(*)::text FROM blog_posts) AS blogs,
      (SELECT count(*)::text FROM events) AS events,
      (SELECT count(*)::text FROM blog_posts WHERE moderation_status = 'pending_review') AS pending_blogs,
      (SELECT count(*)::text FROM events WHERE moderation_status = 'pending_review') AS pending_events,
      (SELECT count(*)::text FROM contact_inquiries WHERE status IN ('received', 'triaged', 'in_progress')) AS open_inquiries,
      (SELECT count(*)::text FROM newsletter_subscriptions WHERE status = 'active') AS active_subscribers,
      (SELECT count(*)::text FROM users) AS users`);
    const counts = rows[0];
    res.json({
      generatedAt: new Date().toISOString(),
      content: {
        blogs: Number(counts?.blogs ?? 0),
        events: Number(counts?.events ?? 0),
        pendingReview: Number(counts?.pending_blogs ?? 0) + Number(counts?.pending_events ?? 0),
      },
      submissions: {
        openInquiries: Number(counts?.open_inquiries ?? 0),
        activeSubscribers: Number(counts?.active_subscribers ?? 0),
      },
      users: Number(counts?.users ?? 0),
      database: await databaseSnapshot(),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/metrics/snapshot', async (_req, res, next) => {
  try {
    res.json(metrics.snapshot(await databaseSnapshot()));
  } catch (error) {
    next(error);
  }
});

router.get('/audit-events', async (req, res, next) => {
  try {
    const { limit, offset, action, resourceType } = auditQuerySchema.parse(req.query);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (action) {
      values.push(action);
      conditions.push(`action = $${values.length}`);
    }
    if (resourceType) {
      values.push(resourceType);
      conditions.push(`resource_type = $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM audit_events ${where}`, values);
    values.push(limit, offset);
    const result = await db.query(`SELECT id, actor_id, action, resource_type, resource_id, metadata, request_id, occurred_at
      FROM audit_events ${where} ORDER BY occurred_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    res.json({ items: result.rows, total: Number(countResult.rows[0]?.count ?? 0), limit, offset });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_query', 'Audit filters are invalid.', { issues: error.issues }));
    next(error);
  }
});

router.get('/inquiries', async (req, res, next) => {
  try {
    const { limit, offset, search, status } = inquiryListSchema.parse(req.query);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (status !== 'all') { values.push(status); conditions.push(`status = $${values.length}`); }
    if (search) {
      values.push(`%${search}%`);
      const index = values.length;
      conditions.push(`(name ILIKE $${index} OR email ILIKE $${index} OR subject ILIKE $${index} OR message ILIKE $${index})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const count = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM contact_inquiries ${where}`, values);
    const resultValues = [...values, limit, offset];
    const result = await db.query(
      `SELECT id, name, CONCAT(LEFT(split_part(email, '@', 1), 1), '***@', split_part(email, '@', 2)) AS email,
       subject, LEFT(message, 180) AS message_preview, status, source, spam_score, created_at, updated_at
       FROM contact_inquiries ${where} ORDER BY created_at DESC LIMIT $${resultValues.length - 1} OFFSET $${resultValues.length}`,
      resultValues);
    res.json({ items: result.rows, total: Number(count.rows[0]?.count ?? 0), limit, offset });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_query', 'Submission filters are invalid.', { issues: error.issues }));
    next(error);
  }
});

router.get('/inquiries/:id', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const result = await db.query(
      `SELECT id, name, email, subject, message, status, source, spam_score, created_at, updated_at
       FROM contact_inquiries WHERE id = $1`, [id]);
    if (!result.rows[0]) throw new AppError(404, 'inquiry_not_found', 'Inquiry not found.');
    void recordAuditEvent({
      actorId: req.user?.id,
      action: 'admin.inquiry.read',
      resourceType: 'contact_inquiry',
      resourceId: id,
      requestId: req.headers['x-request-id'] as string | undefined,
    });
    res.json(result.rows[0]);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_inquiry_id', 'A valid inquiry id is required.'));
    next(error);
  }
});

router.patch('/inquiries/:id', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const status = inquiryStatusSchema.parse(req.body?.status);
    const result = await db.query(
      `UPDATE contact_inquiries SET status = $1, handled_at = CASE WHEN $1 IN ('resolved','spam') THEN NOW() ELSE NULL END, updated_at = NOW()
       WHERE id = $2 RETURNING id, name, email, subject, message, status, source, spam_score, created_at, updated_at`, [status, id]);
    if (!result.rows[0]) throw new AppError(404, 'inquiry_not_found', 'Inquiry not found.');
    void recordAuditEvent({ actorId: req.user?.id, action: 'admin.inquiry.status_update', resourceType: 'contact_inquiry', resourceId: id, metadata: { status }, requestId: req.headers['x-request-id'] as string | undefined });
    res.json(result.rows[0]);
  } catch (error) { if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_inquiry_update', 'A valid inquiry id and status are required.')); next(error); }
});

router.get('/subscribers', async (req, res, next) => {
  try {
    const { limit, offset, search, status } = subscriberListSchema.parse(req.query);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (status !== 'all') { values.push(status); conditions.push(`status = $${values.length}`); }
    if (search) {
      values.push(`%${search}%`);
      const index = values.length;
      conditions.push(`(email ILIKE $${index} OR source ILIKE $${index})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const count = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM newsletter_subscriptions ${where}`, values);
    const resultValues = [...values, limit, offset];
    const result = await db.query(
      `SELECT id, CONCAT(LEFT(split_part(email, '@', 1), 1), '***@', split_part(email, '@', 2)) AS email,
       status, source, consented_at, confirmed_at, last_delivery_at, created_at, updated_at
       FROM newsletter_subscriptions ${where} ORDER BY created_at DESC LIMIT $${resultValues.length - 1} OFFSET $${resultValues.length}`,
      resultValues);
    res.json({ items: result.rows, total: Number(count.rows[0]?.count ?? 0), limit, offset });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_query', 'Subscriber filters are invalid.', { issues: error.issues }));
    next(error);
  }
});

router.get('/users', async (req, res, next) => {
  try {
    const { limit, offset, search, status } = userListSchema.parse(req.query);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (status !== 'all') { values.push(status); conditions.push(`role = $${values.length}`); }
    if (search) {
      values.push(`%${search}%`);
      const index = values.length;
      conditions.push(`(name ILIKE $${index} OR email ILIKE $${index} OR role ILIKE $${index} OR auth_provider ILIKE $${index})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const count = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM users ${where}`, values);
    const resultValues = [...values, limit, offset];
    const result = await db.query(
      `SELECT id, name, CONCAT(LEFT(split_part(email, '@', 1), 1), '***@', split_part(email, '@', 2)) AS email,
       role, auth_provider, created_at, updated_at
       FROM users ${where} ORDER BY created_at DESC LIMIT $${resultValues.length - 1} OFFSET $${resultValues.length}`,
      resultValues);
    res.json({ items: result.rows, total: Number(count.rows[0]?.count ?? 0), limit, offset });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_query', 'User filters are invalid.', { issues: error.issues }));
    next(error);
  }
});

router.get('/blogs', async (req, res, next) => {
  try {
    const { limit, offset } = paginationSchema.parse(req.query);
    const result = await db.query(`SELECT * FROM blog_posts ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post('/blogs', async (req, res, next) => {
  try {
    const payload = blogPayloadSchema.parse(req.body ?? {});
    await assertMediaExists(payload.imageMediaId);
    const result = await db.query(
      `INSERT INTO blog_posts (title, slug, content, meta_title, meta_description, published, published_at, moderation_status, created_at, updated_at, image_media_id)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 THEN NOW() ELSE NULL END, CASE WHEN $6 THEN 'approved' ELSE 'draft' END, NOW(), NOW(), $7)
       RETURNING *`,
      [
        payload.title,
        payload.slug,
        payload.content,
        payload.metaTitle ?? null,
        payload.metaDescription ?? null,
        payload.published,
        payload.imageMediaId ?? null,
      ]
    );
    void recordAuditEvent({
      actorId: req.user?.id,
      action: 'admin.blog.create',
      resourceType: 'blog_post',
      resourceId: result.rows[0]?.id,
      metadata: { slug: payload.slug, published: payload.published },
      requestId: req.headers['x-request-id'] as string | undefined,
    });
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(422, 'invalid_payload', 'Blog payload is invalid.', { issues: error.issues }));
    }
    next(error);
  }
});

router.patch('/blogs/:id', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const expectedVersion = requireVersion(req);
    const payload = blogUpdateSchema.parse(req.body ?? {});
    await assertMediaExists(payload.imageMediaId);
    const fields: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    if (payload.title !== undefined) add('title', payload.title);
    if (payload.slug !== undefined) add('slug', payload.slug);
    if (payload.content !== undefined) add('content', payload.content);
    if (payload.metaTitle !== undefined) add('meta_title', payload.metaTitle);
    if (payload.metaDescription !== undefined) add('meta_description', payload.metaDescription);
    if (payload.imageMediaId !== undefined) add('image_media_id', payload.imageMediaId);
    if (!fields.length) throw new AppError(422, 'invalid_payload', 'At least one blog field is required.');

    values.push(id, expectedVersion);
    const result = await db.query(
      `UPDATE blog_posts SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length - 1} AND updated_at = $${values.length}
       RETURNING *`,
      values,
    );
    if (!result.rows[0]) {
      const exists = await db.query('SELECT 1 FROM blog_posts WHERE id = $1', [id]);
      throw new AppError(exists.rows[0] ? 409 : 404, exists.rows[0] ? 'concurrent_update' : 'blog_not_found', exists.rows[0] ? 'The blog changed since it was loaded. Refresh and try again.' : 'Blog post not found.');
    }
    res.setHeader('ETag', `"${result.rows[0].updated_at}"`);
    void recordAuditEvent({ actorId: req.user?.id, action: 'admin.blog.update', resourceType: 'blog_post', resourceId: id, metadata: { fields: Object.keys(payload) }, requestId: req.headers['x-request-id'] as string | undefined });
    res.json(result.rows[0]);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_payload', 'Blog update payload is invalid.', { issues: error.issues }));
    if (isUniqueViolation(error)) return next(new AppError(409, 'blog_slug_already_exists', 'A blog post with this slug already exists.'));
    next(error);
  }
});

router.delete('/blogs/:id', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const expectedVersion = requireVersion(req);
    const result = await db.query<{ id: string }>('DELETE FROM blog_posts WHERE id = $1 AND updated_at = $2 RETURNING id', [id, expectedVersion]);
    if (!result.rows[0]) {
      const exists = await db.query('SELECT 1 FROM blog_posts WHERE id = $1', [id]);
      throw new AppError(exists.rows[0] ? 409 : 404, exists.rows[0] ? 'concurrent_update' : 'blog_not_found', exists.rows[0] ? 'The blog changed since it was loaded. Refresh and try again.' : 'Blog post not found.');
    }
    void recordAuditEvent({ actorId: req.user?.id, action: 'admin.blog.delete', resourceType: 'blog_post', resourceId: id, requestId: req.headers['x-request-id'] as string | undefined });
    res.status(204).send();
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(400, 'invalid_blog_id', 'Blog id must be a UUID.'));
    next(error);
  }
});

router.get('/events', async (req, res, next) => {
  try {
    const { limit, offset } = paginationSchema.parse(req.query);
    const result = await db.query(`SELECT * FROM events ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post('/events', async (req, res, next) => {
  try {
    const payload = eventPayloadSchema.parse(req.body ?? {});
    await assertMediaExists(payload.imageMediaId);
    const result = await db.query(
      `INSERT INTO events (title, slug, description, event_date, ends_at, all_day, location, published, moderation_status, capacity, registration_url, meta_title, meta_description, created_at, updated_at, image_media_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8 THEN 'approved' ELSE 'draft' END, $9, $10, $11, $12, NOW(), NOW(), $13)
       RETURNING *`,
      [
        payload.title,
        payload.slug,
        payload.description,
        payload.eventDate,
        payload.endsAt ?? null,
        payload.allDay,
        payload.location,
        payload.published,
        payload.capacity ?? null,
        payload.registrationUrl ?? null,
        payload.metaTitle ?? null,
        payload.metaDescription ?? null,
        payload.imageMediaId ?? null,
      ]
    );
    void recordAuditEvent({
      actorId: req.user?.id,
      action: 'admin.event.create',
      resourceType: 'event',
      resourceId: result.rows[0]?.id,
      metadata: { slug: payload.slug, published: payload.published },
      requestId: req.headers['x-request-id'] as string | undefined,
    });
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(422, 'invalid_payload', 'Event payload is invalid.', { issues: error.issues }));
    }
    if (isConstraintViolation(error)) return next(new AppError(422, 'invalid_event_range', 'Event end time must be on or after its start time, and capacity cannot be negative.'));
    next(error);
  }
});

router.patch('/events/:id', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const expectedVersion = requireVersion(req);
    const payload = eventUpdateSchema.parse(req.body ?? {});
    await assertMediaExists(payload.imageMediaId);
    const fields: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    if (payload.title !== undefined) add('title', payload.title);
    if (payload.slug !== undefined) add('slug', payload.slug);
    if (payload.description !== undefined) add('description', payload.description);
    if (payload.eventDate !== undefined) add('event_date', payload.eventDate);
    if (payload.endsAt !== undefined) add('ends_at', payload.endsAt);
    if (payload.allDay !== undefined) add('all_day', payload.allDay);
    if (payload.location !== undefined) add('location', payload.location);
    if (payload.capacity !== undefined) add('capacity', payload.capacity);
    if (payload.registrationUrl !== undefined) add('registration_url', payload.registrationUrl);
    if (payload.metaTitle !== undefined) add('meta_title', payload.metaTitle);
    if (payload.metaDescription !== undefined) add('meta_description', payload.metaDescription);
    if (payload.imageMediaId !== undefined) add('image_media_id', payload.imageMediaId);
    if (!fields.length) throw new AppError(422, 'invalid_payload', 'At least one event field is required.');

    values.push(id, expectedVersion);
    const result = await db.query(
      `UPDATE events SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length - 1} AND updated_at = $${values.length}
       RETURNING *`,
      values,
    );
    if (!result.rows[0]) {
      const exists = await db.query('SELECT 1 FROM events WHERE id = $1', [id]);
      throw new AppError(exists.rows[0] ? 409 : 404, exists.rows[0] ? 'concurrent_update' : 'event_not_found', exists.rows[0] ? 'The event changed since it was loaded. Refresh and try again.' : 'Event not found.');
    }
    res.setHeader('ETag', `"${result.rows[0].updated_at}"`);
    void recordAuditEvent({ actorId: req.user?.id, action: 'admin.event.update', resourceType: 'event', resourceId: id, metadata: { fields: Object.keys(payload) }, requestId: req.headers['x-request-id'] as string | undefined });
    res.json(result.rows[0]);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_payload', 'Event update payload is invalid.', { issues: error.issues }));
    if (isUniqueViolation(error)) return next(new AppError(409, 'event_slug_already_exists', 'An event with this slug already exists.'));
    if (isConstraintViolation(error)) return next(new AppError(422, 'invalid_event_range', 'Event end time must be on or after its start time, and capacity cannot be negative.'));
    next(error);
  }
});

router.delete('/events/:id', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const expectedVersion = requireVersion(req);
    const result = await db.query<{ id: string }>('DELETE FROM events WHERE id = $1 AND updated_at = $2 RETURNING id', [id, expectedVersion]);
    if (!result.rows[0]) {
      const exists = await db.query('SELECT 1 FROM events WHERE id = $1', [id]);
      throw new AppError(exists.rows[0] ? 409 : 404, exists.rows[0] ? 'concurrent_update' : 'event_not_found', exists.rows[0] ? 'The event changed since it was loaded. Refresh and try again.' : 'Event not found.');
    }
    void recordAuditEvent({ actorId: req.user?.id, action: 'admin.event.delete', resourceType: 'event', resourceId: id, requestId: req.headers['x-request-id'] as string | undefined });
    res.status(204).send();
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(400, 'invalid_event_id', 'Event id must be a UUID.'));
    next(error);
  }
});

router.post('/:resource/:id/moderation/:action', async (req, res, next) => {
  try {
    const resource = z.enum(['blogs', 'events']).parse(req.params.resource);
    const id = z.string().uuid().parse(req.params.id);
    const action = z.enum(['submit-review', 'approve', 'reject', 'archive']).parse(req.params.action);
    const expectedVersion = requireVersion(req);
    const table = resource === 'blogs' ? 'blog_posts' : 'events';
    const resourceType = resource === 'blogs' ? 'blog_post' : 'event';
    const moderationStatus = action === 'submit-review' ? 'pending_review' : action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'archived';
    const published = moderationStatus === 'approved';
    const result = await db.query(
      `UPDATE ${table}
       SET moderation_status = $1,
           published = $2,
           published_at = CASE WHEN $2 THEN COALESCE(published_at, NOW()) ELSE NULL END,
           updated_at = NOW()
       WHERE id = $3 AND updated_at = $4
       RETURNING *`,
      [moderationStatus, published, id, expectedVersion],
    );
    if (!result.rows[0]) {
      const exists = await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
      throw new AppError(exists.rows[0] ? 409 : 404, exists.rows[0] ? 'concurrent_update' : `${resourceType}_not_found`, exists.rows[0] ? `The ${resourceType} changed since it was loaded. Refresh and try again.` : `${resourceType} not found.`);
    }
    void recordAuditEvent({ actorId: req.user?.id, action: `admin.${resourceType}.moderation.${action}`, resourceType, resourceId: id, metadata: { moderationStatus }, requestId: req.headers['x-request-id'] as string | undefined });
    res.setHeader('ETag', `"${result.rows[0].updated_at}"`);
    res.json(result.rows[0]);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_moderation_request', 'Resource, id, action, or version is invalid.', { issues: error.issues }));
    next(error);
  }
});

export default router;
