export class AppError extends Error {
    status;
    error;
    details;
    constructor(status, error, message, details) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.error = error;
        this.details = details;
    }
    toResponse() {
        return {
            error: this.error,
            message: this.message,
            ...(this.details ? { details: this.details } : {}),
        };
    }
}
export function normalizeDbError(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return 'Database operation failed';
}
