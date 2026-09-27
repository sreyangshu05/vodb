import { Router } from 'express';
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
const router = Router();
const loginLimiter = createRateLimiter({
    windowMs: env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS,
    max: env.ADMIN_LOGIN_RATE_LIMIT_MAX_REQUESTS,
    message: 'Too many admin login attempts. Please retry later.',
});
const paginationSchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
const auditQuerySchema = paginationSchema.extend({
    action: z.string().trim().max(80).optional(),
    resourceType: z.string().trim().max(80).optional(),
});
const inquiryStatusSchema = z.enum(['received', 'triaged', 'in_progress', 'resolved', 'spam']);
const subscriberStatusSchema = z.enum(['pending', 'active', 'unsubscribed', 'bounced', 'complained']);
async function databaseSnapshot() {
    try {
        await db.healthcheck();
        return { status: 'ready', pool: db.poolStats() };
    }
    catch {
        return { status: 'unavailable', pool: db.poolStats() };
    }
}
function isUniqueViolation(error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code === '23505';
}
function requireVersion(req) {
    const header = req.get('if-match');
    const version = header?.replace(/^W\//, '').replace(/^"|"$/g, '');
    if (!version)
        throw new AppError(428, 'precondition_required', 'If-Match must contain the record version.');
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
        const token = signToken(user);
        void recordAuditEvent({
            action: 'admin.login',
            resourceType: 'admin_session',
            resourceId: user.id,
            metadata: { email: user.email },
            requestId: req.headers['x-request-id'],
        });
        res.json({ token, user });
    }
    catch (error) {
        if (error instanceof AppError) {
            return next(error);
        }
        next(error);
    }
});
router.use(requireAuth, requireAdmin);
async function assertMediaExists(id) {
    if (!id)
        return;
    const result = await db.query('SELECT 1 FROM media_assets WHERE id = $1', [id]);
    if (!result.rows[0])
        throw new AppError(422, 'invalid_media_reference', 'The selected image does not exist.');
}
router.get('/me', (req, res) => {
    res.json({ user: req.user });
});
router.get('/overview', async (_req, res, next) => {
    try {
        const [blogs, events, pendingBlogs, pendingEvents, inquiries, subscribers, users] = await Promise.all([
            db.query('SELECT count(*)::text AS count FROM blog_posts'),
            db.query('SELECT count(*)::text AS count FROM events'),
            db.query("SELECT count(*)::text AS count FROM blog_posts WHERE moderation_status = 'pending_review'"),
            db.query("SELECT count(*)::text AS count FROM events WHERE moderation_status = 'pending_review'"),
            db.query("SELECT count(*)::text AS count FROM contact_inquiries WHERE status IN ('received', 'triaged', 'in_progress')"),
            db.query("SELECT count(*)::text AS count FROM newsletter_subscriptions WHERE status = 'active'"),
            db.query('SELECT count(*)::text AS count FROM users'),
        ]);
        res.json({
            generatedAt: new Date().toISOString(),
            content: {
                blogs: Number(blogs.rows[0]?.count ?? 0),
                events: Number(events.rows[0]?.count ?? 0),
                pendingReview: Number(pendingBlogs.rows[0]?.count ?? 0) + Number(pendingEvents.rows[0]?.count ?? 0),
            },
            submissions: {
                openInquiries: Number(inquiries.rows[0]?.count ?? 0),
                activeSubscribers: Number(subscribers.rows[0]?.count ?? 0),
            },
            users: Number(users.rows[0]?.count ?? 0),
            database: await databaseSnapshot(),
        });
    }
    catch (error) {
        next(error);
    }
});
router.get('/metrics/snapshot', async (_req, res, next) => {
    try {
        res.json(metrics.snapshot(await databaseSnapshot()));
    }
    catch (error) {
        next(error);
    }
});
router.get('/audit-events', async (req, res, next) => {
    try {
        const { limit, offset, action, resourceType } = auditQuerySchema.parse(req.query);
        const values = [];
        const conditions = [];
        if (action) {
            values.push(action);
            conditions.push(`action = $${values.length}`);
        }
        if (resourceType) {
            values.push(resourceType);
            conditions.push(`resource_type = $${values.length}`);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const countResult = await db.query(`SELECT count(*)::text AS count FROM audit_events ${where}`, values);
        values.push(limit, offset);
        const result = await db.query(`SELECT id, actor_id, action, resource_type, resource_id, metadata, request_id, occurred_at
      FROM audit_events ${where} ORDER BY occurred_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
        res.json({ items: result.rows, total: Number(countResult.rows[0]?.count ?? 0), limit, offset });
    }
    catch (error) {
        if (error instanceof z.ZodError)
            return next(new AppError(422, 'invalid_query', 'Audit filters are invalid.', { issues: error.issues }));
        next(error);
    }
});
router.get('/inquiries', async (req, res, next) => {
    try {
        const { limit, offset } = paginationSchema.parse(req.query);
        const result = await db.query(`SELECT id, name, email, subject, message, status, source, spam_score, created_at, updated_at
       FROM contact_inquiries ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
        const count = await db.query('SELECT count(*)::text AS count FROM contact_inquiries');
        res.json({ items: result.rows, total: Number(count.rows[0]?.count ?? 0) });
    }
    catch (error) {
        next(error);
    }
});
router.patch('/inquiries/:id', async (req, res, next) => {
    try {
        const id = z.string().uuid().parse(req.params.id);
        const status = inquiryStatusSchema.parse(req.body?.status);
        const result = await db.query(`UPDATE contact_inquiries SET status = $1, handled_at = CASE WHEN $1 IN ('resolved','spam') THEN NOW() ELSE NULL END, updated_at = NOW()
       WHERE id = $2 RETURNING id, name, email, subject, message, status, source, spam_score, created_at, updated_at`, [status, id]);
        if (!result.rows[0])
            throw new AppError(404, 'inquiry_not_found', 'Inquiry not found.');
        void recordAuditEvent({ actorId: req.user?.id, action: 'admin.inquiry.status_update', resourceType: 'contact_inquiry', resourceId: id, metadata: { status }, requestId: req.headers['x-request-id'] });
        res.json(result.rows[0]);
    }
    catch (error) {
        if (error instanceof z.ZodError)
            return next(new AppError(422, 'invalid_inquiry_update', 'A valid inquiry id and status are required.'));
        next(error);
    }
});
router.get('/subscribers', async (req, res, next) => {
    try {
        const { limit, offset } = paginationSchema.parse(req.query);
        const result = await db.query(`SELECT id, email, status, source, consented_at, confirmed_at, last_delivery_at, created_at, updated_at FROM newsletter_subscriptions ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
        const count = await db.query('SELECT count(*)::text AS count FROM newsletter_subscriptions');
        res.json({ items: result.rows, total: Number(count.rows[0]?.count ?? 0) });
    }
    catch (error) {
        next(error);
    }
});
router.get('/users', async (req, res, next) => {
    try {
        const { limit, offset } = paginationSchema.parse(req.query);
        const result = await db.query(`SELECT id, name, email, role, auth_provider, created_at, updated_at FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
        const count = await db.query('SELECT count(*)::text AS count FROM users');
        res.json({ items: result.rows, total: Number(count.rows[0]?.count ?? 0) });
    }
    catch (error) {
        next(error);
    }
});
router.get('/blogs', async (req, res, next) => {
    try {
        const { limit, offset } = paginationSchema.parse(req.query);
        const result = await db.query(`SELECT * FROM blog_posts ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
        res.json(result.rows);
    }
    catch (error) {
        next(error);
    }
});
router.post('/blogs', async (req, res, next) => {
    try {
        const payload = blogPayloadSchema.parse(req.body ?? {});
        await assertMediaExists(payload.imageMediaId);
        const result = await db.query(`INSERT INTO blog_posts (title, slug, content, meta_title, meta_description, published, published_at, moderation_status, created_at, updated_at, image_media_id)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 THEN NOW() ELSE NULL END, CASE WHEN $6 THEN 'approved' ELSE 'draft' END, NOW(), NOW(), $7)
       RETURNING *`, [
            payload.title,
            payload.slug,
            payload.content,
            payload.metaTitle ?? null,
            payload.metaDescription ?? null,
            payload.published,
            payload.imageMediaId ?? null,
        ]);
        void recordAuditEvent({
            actorId: req.user?.id,
            action: 'admin.blog.create',
            resourceType: 'blog_post',
            resourceId: result.rows[0]?.id,
            metadata: { slug: payload.slug, published: payload.published },
            requestId: req.headers['x-request-id'],
        });
        res.status(201).json(result.rows[0]);
    }
    catch (error) {
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
        const fields = [];
        const values = [];
        const add = (column, value) => {
            values.push(value);
            fields.push(`${column} = $${values.length}`);
        };
        if (payload.title !== undefined)
            add('title', payload.title);
        if (payload.slug !== undefined)
            add('slug', payload.slug);
        if (payload.content !== undefined)
            add('content', payload.content);
        if (payload.metaTitle !== undefined)
            add('meta_title', payload.metaTitle);
        if (payload.metaDescription !== undefined)
            add('meta_description', payload.metaDescription);
        if (payload.imageMediaId !== undefined)
            add('image_media_id', payload.imageMediaId);
        if (!fields.length)
            throw new AppError(422, 'invalid_payload', 'At least one blog field is required.');
        values.push(id, expectedVersion);
        const result = await db.query(`UPDATE blog_posts SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length - 1} AND updated_at = $${values.length}
       RETURNING *`, values);
        if (!result.rows[0]) {
            const exists = await db.query('SELECT 1 FROM blog_posts WHERE id = $1', [id]);
            throw new AppError(exists.rows[0] ? 409 : 404, exists.rows[0] ? 'concurrent_update' : 'blog_not_found', exists.rows[0] ? 'The blog changed since it was loaded. Refresh and try again.' : 'Blog post not found.');
        }
        res.setHeader('ETag', `"${result.rows[0].updated_at}"`);
        void recordAuditEvent({ actorId: req.user?.id, action: 'admin.blog.update', resourceType: 'blog_post', resourceId: id, metadata: { fields: Object.keys(payload) }, requestId: req.headers['x-request-id'] });
        res.json(result.rows[0]);
    }
    catch (error) {
        if (error instanceof z.ZodError)
            return next(new AppError(422, 'invalid_payload', 'Blog update payload is invalid.', { issues: error.issues }));
        if (isUniqueViolation(error))
            return next(new AppError(409, 'blog_slug_already_exists', 'A blog post with this slug already exists.'));
        next(error);
    }
});
router.delete('/blogs/:id', async (req, res, next) => {
    try {
        const id = z.string().uuid().parse(req.params.id);
        const expectedVersion = requireVersion(req);
        const result = await db.query('DELETE FROM blog_posts WHERE id = $1 AND updated_at = $2 RETURNING id', [id, expectedVersion]);
        if (!result.rows[0]) {
            const exists = await db.query('SELECT 1 FROM blog_posts WHERE id = $1', [id]);
            throw new AppError(exists.rows[0] ? 409 : 404, exists.rows[0] ? 'concurrent_update' : 'blog_not_found', exists.rows[0] ? 'The blog changed since it was loaded. Refresh and try again.' : 'Blog post not found.');
        }
        void recordAuditEvent({ actorId: req.user?.id, action: 'admin.blog.delete', resourceType: 'blog_post', resourceId: id, requestId: req.headers['x-request-id'] });
        res.status(204).send();
    }
    catch (error) {
        if (error instanceof z.ZodError)
            return next(new AppError(400, 'invalid_blog_id', 'Blog id must be a UUID.'));
        next(error);
    }
});
router.get('/events', async (req, res, next) => {
    try {
        const { limit, offset } = paginationSchema.parse(req.query);
        const result = await db.query(`SELECT * FROM events ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
        res.json(result.rows);
    }
    catch (error) {
        next(error);
    }
});
router.post('/events', async (req, res, next) => {
    try {
        const payload = eventPayloadSchema.parse(req.body ?? {});
        await assertMediaExists(payload.imageMediaId);
        const result = await db.query(`INSERT INTO events (title, slug, description, event_date, ends_at, location, published, moderation_status, capacity, registration_url, meta_title, meta_description, created_at, updated_at, image_media_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 THEN 'approved' ELSE 'draft' END, $8, $9, $10, $11, NOW(), NOW(), $12)
       RETURNING *`, [
            payload.title,
            payload.slug,
            payload.description,
            payload.eventDate,
            payload.endsAt ?? null,
            payload.location,
            payload.published,
            payload.capacity ?? null,
            payload.registrationUrl ?? null,
            payload.metaTitle ?? null,
            payload.metaDescription ?? null,
            payload.imageMediaId ?? null,
        ]);
        void recordAuditEvent({
            actorId: req.user?.id,
            action: 'admin.event.create',
            resourceType: 'event',
            resourceId: result.rows[0]?.id,
            metadata: { slug: payload.slug, published: payload.published },
            requestId: req.headers['x-request-id'],
        });
        res.status(201).json(result.rows[0]);
    }
    catch (error) {
        if (error instanceof z.ZodError) {
            return next(new AppError(422, 'invalid_payload', 'Event payload is invalid.', { issues: error.issues }));
        }
        next(error);
    }
});
router.patch('/events/:id', async (req, res, next) => {
    try {
        const id = z.string().uuid().parse(req.params.id);
        const expectedVersion = requireVersion(req);
        const payload = eventUpdateSchema.parse(req.body ?? {});
        await assertMediaExists(payload.imageMediaId);
        const fields = [];
        const values = [];
        const add = (column, value) => {
            values.push(value);
            fields.push(`${column} = $${values.length}`);
        };
        if (payload.title !== undefined)
            add('title', payload.title);
        if (payload.slug !== undefined)
            add('slug', payload.slug);
        if (payload.description !== undefined)
            add('description', payload.description);
        if (payload.eventDate !== undefined)
            add('event_date', payload.eventDate);
        if (payload.endsAt !== undefined)
            add('ends_at', payload.endsAt);
        if (payload.location !== undefined)
            add('location', payload.location);
        if (payload.capacity !== undefined)
            add('capacity', payload.capacity);
        if (payload.registrationUrl !== undefined)
            add('registration_url', payload.registrationUrl);
        if (payload.metaTitle !== undefined)
            add('meta_title', payload.metaTitle);
        if (payload.metaDescription !== undefined)
            add('meta_description', payload.metaDescription);
        if (payload.imageMediaId !== undefined)
            add('image_media_id', payload.imageMediaId);
        if (!fields.length)
            throw new AppError(422, 'invalid_payload', 'At least one event field is required.');
        values.push(id, expectedVersion);
        const result = await db.query(`UPDATE events SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length - 1} AND updated_at = $${values.length}
       RETURNING *`, values);
        if (!result.rows[0]) {
            const exists = await db.query('SELECT 1 FROM events WHERE id = $1', [id]);
            throw new AppError(exists.rows[0] ? 409 : 404, exists.rows[0] ? 'concurrent_update' : 'event_not_found', exists.rows[0] ? 'The event changed since it was loaded. Refresh and try again.' : 'Event not found.');
        }
        res.setHeader('ETag', `"${result.rows[0].updated_at}"`);
        void recordAuditEvent({ actorId: req.user?.id, action: 'admin.event.update', resourceType: 'event', resourceId: id, metadata: { fields: Object.keys(payload) }, requestId: req.headers['x-request-id'] });
        res.json(result.rows[0]);
    }
    catch (error) {
        if (error instanceof z.ZodError)
            return next(new AppError(422, 'invalid_payload', 'Event update payload is invalid.', { issues: error.issues }));
        if (isUniqueViolation(error))
            return next(new AppError(409, 'event_slug_already_exists', 'An event with this slug already exists.'));
        next(error);
    }
});
router.delete('/events/:id', async (req, res, next) => {
    try {
        const id = z.string().uuid().parse(req.params.id);
        const expectedVersion = requireVersion(req);
        const result = await db.query('DELETE FROM events WHERE id = $1 AND updated_at = $2 RETURNING id', [id, expectedVersion]);
        if (!result.rows[0]) {
            const exists = await db.query('SELECT 1 FROM events WHERE id = $1', [id]);
            throw new AppError(exists.rows[0] ? 409 : 404, exists.rows[0] ? 'concurrent_update' : 'event_not_found', exists.rows[0] ? 'The event changed since it was loaded. Refresh and try again.' : 'Event not found.');
        }
        void recordAuditEvent({ actorId: req.user?.id, action: 'admin.event.delete', resourceType: 'event', resourceId: id, requestId: req.headers['x-request-id'] });
        res.status(204).send();
    }
    catch (error) {
        if (error instanceof z.ZodError)
            return next(new AppError(400, 'invalid_event_id', 'Event id must be a UUID.'));
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
        const result = await db.query(`UPDATE ${table}
       SET moderation_status = $1,
           published = $2,
           published_at = CASE WHEN $2 THEN COALESCE(published_at, NOW()) ELSE NULL END,
           updated_at = NOW()
       WHERE id = $3 AND updated_at = $4
       RETURNING *`, [moderationStatus, published, id, expectedVersion]);
        if (!result.rows[0]) {
            const exists = await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
            throw new AppError(exists.rows[0] ? 409 : 404, exists.rows[0] ? 'concurrent_update' : `${resourceType}_not_found`, exists.rows[0] ? `The ${resourceType} changed since it was loaded. Refresh and try again.` : `${resourceType} not found.`);
        }
        void recordAuditEvent({ actorId: req.user?.id, action: `admin.${resourceType}.moderation.${action}`, resourceType, resourceId: id, metadata: { moderationStatus }, requestId: req.headers['x-request-id'] });
        res.setHeader('ETag', `"${result.rows[0].updated_at}"`);
        res.json(result.rows[0]);
    }
    catch (error) {
        if (error instanceof z.ZodError)
            return next(new AppError(422, 'invalid_moderation_request', 'Resource, id, action, or version is invalid.', { issues: error.issues }));
        next(error);
    }
});
export default router;
