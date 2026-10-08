import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import { verifyToken } from '../services/authService.js';
import { db } from '../lib/db.js';
import { env } from '../config/env.js';

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new AppError(401, 'unauthorized', 'Authentication required.'));
  }

  let payload: ReturnType<typeof verifyToken>;
  try {
    const token = header.slice('Bearer '.length).trim();
    payload = verifyToken(token);
  } catch {
    return next(new AppError(401, 'invalid_token', 'Authentication token is invalid or expired.'));
  }

  try {
    if (USER_ID_PATTERN.test(payload.sub)) {
      const result = await db.query<{ token_version: number }>(
        'SELECT token_version FROM users WHERE id = $1',
        [payload.sub],
      );
      if (!result.rows[0] || result.rows[0].token_version !== payload.tokenVersion) {
        return next(new AppError(401, 'invalid_token', 'Authentication token is invalid or expired.'));
      }
    } else if (!(payload.configuredAdmin || env.NODE_ENV === 'test')) {
      return next(new AppError(401, 'invalid_token', 'Authentication token is invalid or expired.'));
    }
    req.user = {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
      role: payload.role,
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) return next();
  return requireAuth(req, res, next);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    return next(new AppError(403, 'forbidden', 'Admin access is required.'));
  }
  return next();
}
