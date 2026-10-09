import type { NextFunction, Request, Response } from 'express';
import { db } from '../lib/db.js';

function messageFromBody(body: unknown, statusCode: number, statusMessage: string): string {
  let payload = body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      // Non-JSON error responses are logged by status below.
    }
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) return record.message.trim().slice(0, 4000);
    if (typeof record.error === 'string' && record.error.trim()) return record.error.trim().slice(0, 4000);
  }

  return `${statusCode} ${statusMessage || 'Request failed'}`.slice(0, 4000);
}

export function apiErrorLogMiddleware(req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res);

  res.json = ((body: unknown) => {
    if (res.statusCode >= 400) {
      res.locals.apiErrorMessage = messageFromBody(body, res.statusCode, res.statusMessage);
    }
    return originalJson(body as never);
  }) as typeof res.json;

  res.on('finish', () => {
    if (res.statusCode < 400) return;

    const endpoint = `${req.method} ${req.originalUrl.split('?', 1)[0]}`.slice(0, 500);
    const errorMessage = typeof res.locals.apiErrorMessage === 'string'
      ? res.locals.apiErrorMessage
      : `${res.statusCode} ${res.statusMessage || 'Request failed'}`;

    void db.logApiError({ endpoint, errorMessage, userId: req.user?.id });
  });

  next();
}
