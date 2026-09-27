function deriveClientKey(req) {
    // Express normalizes req.ip according to the configured proxy trust policy.
    // Do not parse x-forwarded-for directly: an untrusted client can spoof it.
    return req.ip || req.socket?.remoteAddress || 'anonymous';
}
export function createRateLimiter({ windowMs, max, message = 'Too many requests. Please try again later.' }) {
    const hits = new Map();
    let lastCleanup = 0;
    return (req, res, next) => {
        const key = deriveClientKey(req);
        const now = Date.now();
        // Bound process-local memory while retaining the lightweight fallback used
        // in development and when the shared store is unavailable.
        if (now - lastCleanup > windowMs) {
            for (const [entryKey, entry] of hits) {
                if (entry.resetAt <= now)
                    hits.delete(entryKey);
            }
            lastCleanup = now;
        }
        const current = hits.get(key);
        if (!current || now >= current.resetAt) {
            hits.set(key, { count: 1, resetAt: now + windowMs });
            return next();
        }
        if (current.count >= max) {
            return res.status(429).json({ error: 'rate_limited', message });
        }
        current.count += 1;
        next();
    };
}
