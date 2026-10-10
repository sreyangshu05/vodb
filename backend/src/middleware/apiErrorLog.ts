import type { NextFunction, Request, Response } from 'express';
import { db } from '../lib/db.js';

export function safeErrorCodeFromBody(body: unknown): string | undefined {
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
    if (typeof record.error === 'string' && /^[a-z0-9_]{1,80}$/i.test(record.error)) return record.error;
  }
  return undefined;
}

export function apiErrorLogMiddleware(req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res);

  res.json = ((body: unknown) => {
    if (res.statusCode >= 400) {
      res.locals.apiErrorCode = safeErrorCodeFromBody(body);
    }
    return originalJson(body as never);
  }) as typeof res.json;

  res.on('finish', () => {
    if (res.statusCode < 400) return;

    const routePath = req.route?.path;
    const endpointPath = typeof routePath === 'string'
      ? `${req.baseUrl}${routePath}`
      : '<unmatched>';
    const endpoint = `${req.method} ${endpointPath}`.slice(0, 500);
    const errorMessage = typeof res.locals.apiErrorCode === 'string'
      ? res.locals.apiErrorCode
      : `http_${res.statusCode}`;

    void db.logApiError({ endpoint, errorMessage });
  });

  next();
}
