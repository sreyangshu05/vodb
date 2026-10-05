import { Router } from 'express';
import { z } from 'zod';
import { createRateLimiter } from '../middleware/rateLimit.js';
import crypto from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { contactSchema, newsletterDeliveryWebhookSchema, newsletterSchema, newsletterTokenSchema } from '../lib/validators.js';
import { confirmNewsletterSubscription, createContactInquiry, createNewsletterSubscription, discardNewsletterSubscription, processNewsletterDeliveryEvent, resendPendingNewsletterConfirmation, unsubscribeNewsletter } from '../services/submissionService.js';
import { sendNewsletterConfirmation } from '../services/mailService.js';
import { getBlogBySlug, getEventBySlug, listPublishedBlogs, listPublishedEvents, searchPublishedContent } from '../services/contentService.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { answerFromPublishedKnowledge } from '../services/knowledgeService.js';

const router = Router();
const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
const contentSearchSchema = z.object({
  q: z.string().trim().min(2).max(160),
  type: z.enum(['all', 'articles', 'events']).default('all'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
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

const newsletterResendLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: 'Too many confirmation requests. Please wait before trying again.',
});

const knowledgeQuestionLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many knowledge questions. Please wait before trying again.',
});

const contentSearchLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 40, message: 'Too many search requests. Please wait before trying again.' });
const translationLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30, message: 'Too many translation requests. Please wait before trying again.' });
const translationProviders = [
  'https://translate.argosopentech.com/translate',
  'https://libretranslate.de/translate',
  'https://translate.mentality.rip/translate',
];

const contactLimiter = createRateLimiter({
  windowMs: env.CONTACT_RATE_LIMIT_WINDOW_MS,
  max: env.CONTACT_RATE_LIMIT_MAX_REQUESTS,
  message: 'Too many contact submissions. Please wait before sending another message.',
});

router.use(publicLimiter);

router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'voice-of-digi-bengal-backend', timestamp: new Date().toISOString() });
});

const translationSchema = z.object({
  texts: z.array(z.string().max(5000)).min(1).max(100),
  target: z.enum(['bn', 'fr', 'es', 'pt', 'ru', 'de', 'zh-CN', 'nl', 'pl', 'fa', 'ar', 'he']),
});

router.post('/translate', translationLimiter, async (req, res, next) => {
  try {
    const { texts, target } = translationSchema.parse(req.body);
    const indexesToTranslate = texts.map((text, index) => text.trim() ? index : -1).filter((index) => index >= 0);
    if (!indexesToTranslate.length) return res.json({ translatedTexts: texts });
    const requestBody = JSON.stringify({ q: indexesToTranslate.map((index) => texts[index]), source: 'auto', target: target === 'zh-CN' ? 'zh' : target, format: 'text' });
    let translatedValues: string[] | null = null;
    const providerFailures: Array<{ host: string; status?: number; reason: string; code?: string }> = [];
    for (const endpoint of translationProviders) {
      const host = new URL(endpoint).hostname;
      try {
        const upstream = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
          signal: AbortSignal.timeout(18000),
        });
        if (!upstream.ok) {
          providerFailures.push({ host, status: upstream.status, reason: 'http_error' });
          continue;
        }
        let result: unknown;
        try {
          result = await upstream.json();
        } catch {
          providerFailures.push({ host, status: upstream.status, reason: 'invalid_json' });
          continue;
        }
        if (!result || typeof result !== 'object' || !('translatedText' in result)) {
          providerFailures.push({ host, status: upstream.status, reason: 'missing_translation' });
          continue;
        }
        const values = Array.isArray(result.translatedText) ? result.translatedText : [result.translatedText];
        if (values.length === indexesToTranslate.length && values.every((text) => typeof text === 'string')) {
          translatedValues = values as string[];
          break;
        }
        providerFailures.push({ host, status: upstream.status, reason: 'unexpected_translation_shape' });
      } catch (error) {
        const code = error && typeof error === 'object' && 'cause' in error && error.cause && typeof error.cause === 'object' && 'code' in error.cause && typeof error.cause.code === 'string'
          ? error.cause.code
          : undefined;
        providerFailures.push({ host, reason: error instanceof Error ? error.name : 'network_error', ...(code ? { code } : {}) });
      }
    }
    if (!translatedValues) {
      logger.warn('translation_providers_unavailable', { providers: providerFailures });
      return res.status(502).json({ error: 'translation_unavailable', message: 'Translation is temporarily unavailable. Please try again later.' });
    }
    const translatedTexts = [...texts];
    indexesToTranslate.forEach((originalIndex, index) => { translatedTexts[originalIndex] = translatedValues[index]; });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ translatedTexts });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(422).json({ error: 'invalid_translation_request', message: 'The translation request is invalid or contains too much text.' });
    }
    res.status(502).json({ error: 'translation_unavailable', message: 'Translation service is temporarily unavailable.' });
  }
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

router.get('/search', contentSearchLimiter, async (req, res, next) => {
  try {
    const { q, type, limit, offset } = contentSearchSchema.parse(req.query);
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    res.json(await searchPublishedContent(q, type, limit, offset));
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_search_query', 'Search text must be between 2 and 160 characters.'));
    if (isAppErrorLike(error)) return next(error);
    next(new AppError(503, 'content_search_unavailable', 'Published content search is temporarily unavailable.'));
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
      await sendNewsletterConfirmation(record.email, record.confirmationToken, record.unsubscribeToken);
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
      if (error.error === 'newsletter_already_registered') {
        return res.status(202).json({
          success: true,
          message: 'If this email needs confirmation, a confirmation request has been sent. Active subscriptions are unchanged.',
        });
      }
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

router.post('/newsletter/resend-confirmation', newsletterResendLimiter, async (req, res, next) => {
  try {
    const parsed = newsletterSchema.parse(req.body ?? {});
    if (!parsed.website?.trim()) {
      const pending = await resendPendingNewsletterConfirmation(parsed.email);
      if (pending) {
        void sendNewsletterConfirmation(pending.email, pending.confirmationToken, pending.unsubscribeToken)
          .catch(() => logger.warn('newsletter_confirmation_resend_failed'));
      }
    }
    res.status(202).json({
      success: true,
      message: 'If an unconfirmed subscription exists for this email, a confirmation email has been requested. Active subscriptions are unchanged.',
    });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_payload', 'Please provide a valid email address.'));
    next(new AppError(503, 'confirmation_resend_unavailable', 'The newsletter confirmation service is temporarily unavailable.'));
  }
});

router.post('/knowledge/ask', knowledgeQuestionLimiter, async (req, res, next) => {
  try {
    const payload = z.object({ question: z.string().trim().min(4).max(500) }).parse(req.body ?? {});
    res.json(await answerFromPublishedKnowledge(payload.question));
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_question', 'Enter a question between 4 and 500 characters.'));
    next(new AppError(503, 'knowledge_search_unavailable', 'Published knowledge search is temporarily unavailable.'));
  }
});

router.post('/newsletter/confirm', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const token = newsletterTokenSchema.parse(req.body?.token);
    await confirmNewsletterSubscription(token);
    res.json({ success: true, message: 'Your newsletter subscription is confirmed.' });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(400, 'invalid_subscription_token', 'This newsletter action token is invalid.'));
    next(error);
  }
});

router.post('/newsletter/unsubscribe', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const token = newsletterTokenSchema.parse(req.body?.token);
    await unsubscribeNewsletter(token);
    res.json({ success: true, message: 'You have been unsubscribed from the newsletter.' });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(400, 'invalid_subscription_token', 'This newsletter action token is invalid.'));
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
