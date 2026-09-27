import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

function isDatabaseUnavailable(error: unknown): boolean {
  return error instanceof Error && /ECONNREFUSED|connect ECONNREFUSED|password authentication failed|database.*(not|is).*available|timeout of|connection.*refused|connection terminated|could not connect to server|server.*(down|unavailable)|FATAL/i.test(error.message);
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'not_found', message: 'Resource not found.' });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.headers['x-request-id'];

  if (err instanceof AppError) {
    logger.warn('app_error', { requestId, error: err.error, message: err.message, status: err.status });
    return res.status(err.status).json(err.toResponse());
  }

  if (isDatabaseUnavailable(err)) {
    logger.error('database_unavailable', { requestId, message: err instanceof Error ? err.message : 'Database unavailable' });
    return res.status(503).json({
      error: 'service_unavailable',
      message: 'The service is temporarily unavailable. Please try again later.',
    });
  }

  if (err instanceof Error) {
    logger.error('unhandled_error', { requestId, message: err.message, stack: err.stack });
    return res.status(500).json({
      error: 'internal_server_error',
      message: 'An unexpected server error occurred.',
    });
  }

  logger.error('unknown_error', { requestId, payload: err });
  return res.status(500).json({
    error: 'internal_server_error',
    message: 'An unexpected server error occurred.',
  });
}
