import type { ApiErrorShape } from '../types/api.js';

export class AppError extends Error {
  status: number;
  error: string;
  details?: Record<string, unknown>;

  constructor(status: number, error: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.error = error;
    this.details = details;
  }

  toResponse(): ApiErrorShape {
    return {
      error: this.error,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function normalizeDbError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Database operation failed';
}
