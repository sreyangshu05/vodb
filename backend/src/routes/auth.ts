import { Router } from 'express';
import { z } from 'zod';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { authenticateGoogleUser, authenticateUser, createPasswordReset, discardPasswordReset, registerUser, resetPassword, signToken } from '../services/authService.js';
import { sendPasswordResetOtp } from '../services/mailService.js';

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
      } catch (error) {
        await discardPasswordReset(reset.email);
        throw error;
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

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
