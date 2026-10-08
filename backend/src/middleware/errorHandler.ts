import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import { isDatabaseConfigurationError, isDatabaseUnavailable } from '../utils/databaseErrors.js';
import { logger } from '../utils/logger.js';

function safeErrorMetadata(error: unknown) {
  if (!error || typeof error !== 'object') return { errorName: 'UnknownError' };
  const fields: { errorName: string; code?: string; constraint?: string } = {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  };
  if ('code' in error && typeof error.code === 'string') fields.code = error.code.slice(0, 32);
  if ('constraint' in error && typeof error.constraint === 'string') fields.constraint = error.constraint.slice(0, 128);
  return fields;
}

function isDatabaseSchemaUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? error.code : undefined;
  if (code === '42P01' || code === '42703' || code === '3F000') return true;
  return error instanceof Error && /relation .* does not exist|column .* does not exist|schema .* does not exist/i.test(error.message);
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'not_found', message: 'Resource not found.' });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.headers['x-request-id'];
  const requestContext = {
    requestId,
    userId: req.user?.id,
    method: req.method,
    route: req.route?.path ?? '<unmatched>',
  };

  if (err instanceof AppError) {
    logger.warn('app_error', { ...requestContext, error: err.error, message: err.message, status: err.status });
    return res.status(err.status).json(err.toResponse());
  }

  if (err && typeof err === 'object' && 'type' in err) {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: 'Request body exceeds the allowed size.' });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body must contain valid JSON.' });
    }
  }

  if (isDatabaseUnavailable(err)) {
    logger.error('database_unavailable', { ...requestContext, ...safeErrorMetadata(err) });
    return res.status(503).json({
      error: 'service_unavailable',
      message: 'The service is temporarily unavailable. Please try again later.',
    });
  }

  if (isDatabaseConfigurationError(err)) {
    logger.error('database_configuration_error', { ...requestContext, ...safeErrorMetadata(err) });
    return res.status(503).json({
      error: 'service_unavailable',
      message: 'The service is temporarily unavailable. Please contact the site administrator.',
    });
  }

  if (isDatabaseSchemaUnavailable(err)) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    logger.error('database_schema_unavailable', {
      ...requestContext,
      code,
      message: err instanceof Error ? err.message : 'Required database schema is missing',
    });
    return res.status(503).json({
      error: 'database_schema_unavailable',
      message: 'The service database needs an update. Please try again later or contact the site administrator.',
    });
  }

  if (err instanceof Error) {
    logger.error('unhandled_error', { ...requestContext, message: err.message, stack: err.stack });
    return res.status(500).json({
      error: 'internal_server_error',
      message: 'An unexpected server error occurred.',
    });
  }

  logger.error('unknown_error', { ...requestContext, payload: err });
  return res.status(500).json({
    error: 'internal_server_error',
    message: 'An unexpected server error occurred.',
  });
}
