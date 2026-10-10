import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import { ZodError } from 'zod';
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
    logger.warn('app_error', {
      ...requestContext,
      error: err.error,
      ...(process.env.NODE_ENV === 'production' ? {} : { message: err.message }),
      status: err.status,
    });
    return res.status(err.status).json(err.toResponse());
  }

  // Route-level schema parsing must never become a 500 when a handler forwards
  // a ZodError directly. Return only stable paths/messages, never submitted data.
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: 'invalid_request',
      message: 'Request validation failed.',
      details: {
        issues: err.issues.map((issue) => ({
          path: issue.path.map((segment) => String(segment)),
          message: issue.message,
        })),
      },
    });
  }

  if (err && typeof err === 'object' && 'code' in err && err.code === '57014') {
    logger.warn('database_statement_timeout', { ...requestContext, ...safeErrorMetadata(err) });
    return res.status(503).json({
      error: 'database_query_timeout',
      message: 'The request took too long to complete. Please try again later.',
    });
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
      ...safeErrorMetadata(err),
    });
    return res.status(503).json({
      error: 'database_schema_unavailable',
      message: 'The service database needs an update. Please try again later or contact the site administrator.',
    });
  }

  if (err instanceof Error) {
    const diagnostics = process.env.NODE_ENV === 'production'
      ? safeErrorMetadata(err)
      : { ...safeErrorMetadata(err), message: err.message, stack: err.stack };
    logger.error('unhandled_error', { ...requestContext, ...diagnostics });
    return res.status(500).json({
      error: 'internal_server_error',
      message: 'An unexpected server error occurred.',
    });
  }

  logger.error('unknown_error', {
    ...requestContext,
    ...(process.env.NODE_ENV === 'production'
      ? safeErrorMetadata(err)
      : { payload: err }),
  });
  return res.status(500).json({
    error: 'internal_server_error',
    message: 'An unexpected server error occurred.',
  });
}
