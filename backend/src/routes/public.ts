import { Router } from 'express';
import { z } from 'zod';
import { createRateLimiter } from '../middleware/rateLimit.js';
import crypto from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { contactSchema, newsletterDeliveryWebhookSchema, newsletterSchema, newsletterTokenSchema } from '../lib/validators.js';
import { confirmNewsletterSubscription, createContactInquiry, createNewsletterSubscription, discardNewsletterSubscription, processNewsletterDeliveryEvent, unsubscribeNewsletter } from '../services/submissionService.js';
import { sendNewsletterConfirmation } from '../services/mailService.js';
import { getBlogBySlug, getEventBySlug, listPublishedBlogs, listPublishedEvents } from '../services/contentService.js';
import { env } from '../config/env.js';

const router = Router();
const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});

function isAppErrorLike(value: unknown): value is AppError {
  if (value instanceof AppError) {
    return true;
  }

  return !!value && typeof value === 'object' && 'status' in value && 'error' in value && 'message' in value;
}

const publicLimiter = createRateLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_REQUESTS,
});

const newsletterLimiter = createRateLimiter({
  windowMs: env.NEWSLETTER_RATE_LIMIT_WINDOW_MS,
  max: env.NEWSLETTER_RATE_LIMIT_MAX_REQUESTS,
  message: 'Newsletter submissions are temporarily limited. Please try again later.',
});

const contactLimiter = createRateLimiter({
  windowMs: env.CONTACT_RATE_LIMIT_WINDOW_MS,
  max: env.CONTACT_RATE_LIMIT_MAX_REQUESTS,
  message: 'Too many contact submissions. Please wait before sending another message.',
});

router.use(publicLimiter);

router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'voice-of-digi-bengal-backend', timestamp: new Date().toISOString() });
});

router.get('/blogs', async (req, res, next) => {
  try {
    const { limit, offset } = paginationSchema.parse(req.query);
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    const rows = await listPublishedBlogs(limit, offset);
    res.json(rows);
  } catch (error) {
    if (isAppErrorLike(error)) {
      return next(error);
    }
    return next(new AppError(503, 'content_service_unavailable', 'The blog content service is temporarily unavailable.'));
  }
});

router.get('/blogs/slug/:slug', async (req, res, next) => {
  try {
    const slug = z.string().trim().min(1).parse(req.params.slug);
    const blog = await getBlogBySlug(slug);
    res.json(blog);
  } catch (error) {
    next(error);
  }
});

router.get('/events', async (req, res, next) => {
  try {
    const { limit, offset } = paginationSchema.parse(req.query);
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    const rows = await listPublishedEvents(limit, offset);
    res.json(rows);
  } catch (error) {
    if (isAppErrorLike(error)) {
      return next(error);
    }
    return next(new AppError(503, 'content_service_unavailable', 'The events service is temporarily unavailable.'));
  }
});

router.get('/events/slug/:slug', async (req, res, next) => {
  try {
    const slug = z.string().trim().min(1).parse(req.params.slug);
    const event = await getEventBySlug(slug);
    res.json(event);
  } catch (error) {
    next(error);
  }
});

router.post('/newsletter/subscribe', newsletterLimiter, async (req, res, next) => {
  try {
    const parsed = newsletterSchema.parse(req.body ?? {});
    if (parsed.website?.trim()) {
      return res.status(202).json({ success: true, message: 'Subscription received. Check your email to confirm it.' });
    }
    const record = await createNewsletterSubscription(parsed);
    try {
      await sendNewsletterConfirmation(record.email, record.confirmationToken);
    } catch (error) {
      await discardNewsletterSubscription(record.confirmationToken);
      throw error;
    }
    res.status(201).json({
      success: true,
      email: record.email,
      status: record.status,
      message: 'Subscription received. Check your email to confirm it.',
    });
  } catch (error) {
    if (isAppErrorLike(error)) {
      return next(error);
    }
    if (error instanceof z.ZodError) {
      return next(new AppError(422, 'invalid_payload', 'Please provide a valid email address.', {
        issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      }));
    }
    return next(new AppError(503, 'subscription_service_unavailable', 'The newsletter service is temporarily unavailable.'));
  }
});

router.get('/newsletter/confirm', async (req, res, next) => {
  try {
    const token = newsletterTokenSchema.parse(String(req.query.token ?? ''));
    await confirmNewsletterSubscription(token);
    res.json({ success: true, message: 'Your newsletter subscription is confirmed.' });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(400, 'invalid_subscription_token', 'This subscription link is invalid or expired.'));
    next(error);
  }
});

router.get('/newsletter/unsubscribe', async (req, res, next) => {
  try {
    const token = newsletterTokenSchema.parse(String(req.query.token ?? ''));
    await unsubscribeNewsletter(token);
    res.json({ success: true, message: 'You have been unsubscribed from the newsletter.' });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(400, 'invalid_subscription_token', 'This unsubscribe link is invalid or expired.'));
    next(error);
  }
});

router.post('/newsletter/webhooks/delivery', async (req, res, next) => {
  try {
    if (!env.NEWSLETTER_WEBHOOK_SECRET) throw new AppError(503, 'newsletter_webhook_unavailable', 'Newsletter webhook verification is not configured.');
    const signature = req.get('x-newsletter-signature') ?? '';
    const expected = crypto.createHmac('sha256', env.NEWSLETTER_WEBHOOK_SECRET).update(JSON.stringify(req.body ?? {})).digest('hex');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw new AppError(401, 'invalid_webhook_signature', 'Newsletter webhook signature is invalid.');
    }
    const payload = newsletterDeliveryWebhookSchema.parse(req.body ?? {});
    await processNewsletterDeliveryEvent(payload.event, payload.email);
    res.status(204).send();
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_webhook_payload', 'Newsletter webhook payload is invalid.', { issues: error.issues }));
    next(error);
  }
});

router.post('/contact', contactLimiter, async (req, res, next) => {
  try {
    const parsed = contactSchema.parse(req.body ?? {});
    if (parsed.website?.trim()) {
      return res.status(202).json({ success: true, message: 'Your message has been received.' });
    }
    const record = await createContactInquiry(parsed);
    res.status(201).json({
      success: true,
      message: 'Your message has been received.',
      id: record.id,
      status: record.status,
    });
  } catch (error) {
    if (isAppErrorLike(error)) {
      return next(error);
    }
    if (error instanceof z.ZodError) {
      return next(new AppError(422, 'invalid_payload', 'Please complete all required fields with valid values.', {
        issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      }));
    }
    return next(new AppError(503, 'contact_service_unavailable', 'The contact service is temporarily unavailable.'));
  }
});

export default router;
