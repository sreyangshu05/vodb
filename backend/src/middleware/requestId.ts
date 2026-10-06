import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { metrics } from '../services/metricsService.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const suppliedRequestId = req.headers['x-request-id'];
  const requestId = typeof suppliedRequestId === 'string' && UUID_PATTERN.test(suppliedRequestId)
    ? suppliedRequestId
    : randomUUID();
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-Id', requestId);
  const metricRequest = metrics.requestStarted(req);
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    metrics.requestCompleted(metricRequest.key, res.statusCode, metricRequest.startedAt);
    logger.info('request_completed', {
      requestId,
      userId: req.user?.id,
      method: req.method,
      route: metricRequest.key,
      status: res.statusCode,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    });
  });
  next();
}
