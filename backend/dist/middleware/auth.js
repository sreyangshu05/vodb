import { AppError } from '../utils/errors.js';
import { verifyToken } from '../services/authService.js';
export function requireAuth(req, _res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return next(new AppError(401, 'unauthorized', 'Authentication required.'));
    }
    try {
        const token = header.slice('Bearer '.length).trim();
        const payload = verifyToken(token);
        req.user = {
            id: payload.sub,
            name: payload.name,
            email: payload.email,
            role: payload.role,
        };
        return next();
    }
    catch {
        return next(new AppError(401, 'invalid_token', 'Authentication token is invalid or expired.'));
    }
}
export function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return next(new AppError(403, 'forbidden', 'Admin access is required.'));
    }
    return next();
}
