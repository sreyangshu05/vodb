import { Router } from 'express';
import { z } from 'zod';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { authenticateGoogleUser, authenticateUser, createPasswordReset, discardPasswordReset, registerUser, resetPassword, signToken } from '../services/authService.js';
import { sendPasswordResetOtp } from '../services/mailService.js';
import { db } from '../lib/db.js';
import { recordAuditEvent } from '../services/auditService.js';
import { logger } from '../utils/logger.js';

const router = Router();
const credentialsSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(128),
});
const registrationSchema = credentialsSchema.extend({
  name: z.string().trim().min(2).max(120),
});
const resetRequestSchema = z.object({ email: z.string().trim().email().max(320) });
const resetPasswordSchema = z.object({
  email: z.string().trim().email().max(320),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be six digits.'),
  password: z.string().min(8).max(128),
});
const googleAuthSchema = z.object({ idToken: z.string().min(1).max(4096) });
const profileSchema = z.object({ name: z.string().trim().min(2).max(120) });
const deleteAccountSchema = z.object({ confirmation: z.literal('DELETE') });
const readerTopics = ['history', 'culture', 'language', 'research', 'arts', 'places', 'economy', 'science', 'events', 'education'] as const;
const preferencesSchema = z.object({ topics: z.array(z.enum(readerTopics)).max(10) });
function isLocalPagePath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\u0000-\u001f]/.test(path)) return false;
  try {
    return new URL(path, 'https://voiceofdigibengal.invalid').origin === 'https://voiceofdigibengal.invalid';
  } catch {
    return false;
  }
}
const savedPageSchema = z.object({
  path: z.string().trim().min(1).max(2048).refine(isLocalPagePath, 'A local page path is required.'),
  title: z.string().trim().min(1).max(240),
});
const savedPagePathSchema = z.object({
  path: z.string().trim().min(1).max(2048).refine(isLocalPagePath, 'A local page path is required.'),
});
const authLimiter = createRateLimiter({
  windowMs: env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS,
  max: env.ADMIN_LOGIN_RATE_LIMIT_MAX_REQUESTS,
  message: 'Too many authentication attempts. Please retry later.',
});

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const payload = registrationSchema.parse(req.body ?? {});
    const user = await registerUser(payload.name, payload.email, payload.password);
    res.status(201).json({ token: signToken(user), user });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(422, 'invalid_payload', 'Name, email, and a valid password are required.', { issues: error.issues }));
    }
    if (error instanceof AppError && error.error === 'account_already_exists') {
      return next(new AppError(409, 'account_unavailable', 'We could not create an account with those details. Try signing in or resetting your password.'));
    }
    next(error);
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const payload = credentialsSchema.parse(req.body ?? {});
    const user = await authenticateUser(payload.email, payload.password);
    res.json({ token: signToken(user), user });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(401, 'invalid_credentials', 'Email or password is incorrect.'));
    }
    next(error);
  }
});

router.post('/google', authLimiter, async (req, res, next) => {
  try {
    const payload = googleAuthSchema.parse(req.body ?? {});
    const user = await authenticateGoogleUser(payload.idToken);
    res.json({ token: signToken(user), user });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(401, 'invalid_google_token', 'Google sign-in could not be verified.'));
    }
    next(error);
  }
});

router.post('/forgot-password', authLimiter, async (req, res, next) => {
  try {
    const payload = resetRequestSchema.parse(req.body ?? {});
    const reset = await createPasswordReset(payload.email);
    if (reset) {
      try {
        await sendPasswordResetOtp(reset.email, reset.code);
      } catch {
        await discardPasswordReset(reset.email);
        logger.warn('password_reset_delivery_failed');
      }
    }
    res.status(202).json({ message: 'If an account exists for that email, a password reset OTP has been sent.' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(422, 'invalid_payload', 'Please provide a valid email address.', { issues: error.issues }));
    }
    next(error);
  }
});

router.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const payload = resetPasswordSchema.parse(req.body ?? {});
    await resetPassword(payload.email, payload.otp, payload.password);
    res.json({ message: 'Your password has been reset. You can now sign in.' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(422, 'invalid_payload', 'Email, a six-digit OTP, and a valid password are required.', { issues: error.issues }));
    }
    next(error);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query<{ id: string; name: string; email: string; role: 'member' | 'editor' | 'admin'; reader_preferences: { topics: string[] } }>(
      'SELECT id, name, email, role, reader_preferences FROM users WHERE id = $1', [req.user!.id],
    );
    const user = result.rows[0];
    if (!user) throw new AppError(401, 'account_unavailable', 'This account is no longer available. Please sign in again.');
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

router.delete('/me', requireAuth, async (req, res, next) => {
  if (req.user!.role !== 'member') {
    return next(new AppError(403, 'account_deletion_unavailable', 'Only reader member accounts can be deleted here.'));
  }

  try {
    deleteAccountSchema.parse(req.body ?? {});
    const result = await db.query<{ id: string }>(
      "DELETE FROM users WHERE id = $1 AND role = 'member' RETURNING id", [req.user!.id],
    );
    if (!result.rowCount) throw new AppError(404, 'account_not_found', 'Account not found.');
    void recordAuditEvent({
      actorId: result.rows[0].id,
      action: 'member.account.delete',
      resourceType: 'user',
      resourceId: result.rows[0].id,
      metadata: { scope: 'account_owned_data' },
      requestId: req.headers['x-request-id'] as string | undefined,
    });
    res.status(204).send();
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'account_deletion_confirmation_required', 'Type DELETE to confirm account removal.'));
    next(error);
  }
});

router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const { name } = profileSchema.parse(req.body ?? {});
    const result = await db.query<{ id: string; name: string; email: string; role: 'member' | 'editor' | 'admin' }>(
      'UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, email, role',
      [name, req.user!.id],
    );
    if (!result.rows[0]) throw new AppError(404, 'account_not_found', 'Account not found.');
    const user = result.rows[0];
    res.json({ token: signToken(user), user });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_profile', 'Enter a name between 2 and 120 characters.', { issues: error.issues }));
    next(error);
  }
});

router.patch('/me/preferences', requireAuth, async (req, res, next) => {
  try {
    const preferences = preferencesSchema.parse(req.body ?? {});
    const result = await db.query<{ reader_preferences: { topics: string[] } }>(
      'UPDATE users SET reader_preferences = $1::jsonb, updated_at = NOW() WHERE id = $2 RETURNING reader_preferences',
      [JSON.stringify({ topics: [...new Set(preferences.topics)] }), req.user!.id],
    );
    if (!result.rows[0]) throw new AppError(404, 'account_not_found', 'Account not found.');
    res.json({ preferences: result.rows[0].reader_preferences });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_preferences', 'Choose up to 10 valid topics.', { issues: error.issues }));
    next(error);
  }
});

router.get('/me/saved-pages', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query<{ path: string; title: string; created_at: string }>(
      'SELECT page_path AS path, title, created_at FROM user_saved_pages WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user!.id],
    );
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/me/saved-pages', requireAuth, async (req, res, next) => {
  try {
    const page = savedPageSchema.parse(req.body ?? {});
    const result = await db.query<{ path: string; title: string; created_at: string }>(
      `INSERT INTO user_saved_pages (user_id, page_path, title)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, page_path) DO UPDATE SET title = EXCLUDED.title
       RETURNING page_path AS path, title, created_at`,
      [req.user!.id, page.path, page.title],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_saved_page', 'A local page path and title are required.', { issues: error.issues }));
    next(error);
  }
});

router.delete('/me/saved-pages', requireAuth, async (req, res, next) => {
  try {
    const { path } = savedPagePathSchema.parse(req.body ?? {});
    const result = await db.query(
      'DELETE FROM user_saved_pages WHERE user_id = $1 AND page_path = $2', [req.user!.id, path],
    );
    if (!result.rowCount) throw new AppError(404, 'saved_page_not_found', 'Saved page not found.');
    res.status(204).send();
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(422, 'invalid_saved_page', 'A local page path is required.', { issues: error.issues }));
    next(error);
  }
});

export default router;
