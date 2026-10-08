import { createHmac } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { db } from '../lib/db.js';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
  shared?: boolean;
  keyPrefix?: string;
  identity?: (req: Request) => string | undefined;
  identityMax?: number;
}

function deriveClientKey(req: Request): string {
  // Express normalizes req.ip according to the configured proxy trust policy.
  // Do not parse x-forwarded-for directly: an untrusted client can spoof it.
  return req.ip || req.socket?.remoteAddress || 'anonymous';
}

export function createRateLimiter({
  windowMs,
  max,
  message = 'Too many requests. Please try again later.',
  shared = false,
  keyPrefix = 'general',
  identity,
  identityMax = max,
}: RateLimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastCleanup = 0;
  const maxLocalBuckets = 10_000;

  return async (req: Request, res: Response, next: NextFunction) => {
    const keys = [{ key: `${keyPrefix}:ip:${deriveClientKey(req)}`, max }];
    const identityValue = identity?.(req)?.trim().toLowerCase();
    if (identityValue && identityValue.length <= 320) {
      keys.push({ key: `${keyPrefix}:identity:${identityValue}`, max: identityMax });
    }
    const now = Date.now();
    const useSharedStorage = shared && !(
      env.NODE_ENV === 'test' &&
      process.env.BACKEND_TEST_DATABASE_MODE === 'unavailable'
    );

    try {
      if (useSharedStorage) {
        for (const { key, max: bucketMax } of keys) {
          const bucketKey = createHmac('sha256', env.JWT_SECRET).update(key).digest('hex');
          const result = await db.query<{ request_count: number; window_started_at: string }>(`
            INSERT INTO rate_limit_buckets (bucket_key, window_started_at, request_count)
            VALUES ($1, NOW(), 1)
            ON CONFLICT (bucket_key) DO UPDATE SET
              window_started_at = CASE
                WHEN rate_limit_buckets.window_started_at <= NOW() - ($2::double precision * INTERVAL '1 millisecond')
                THEN NOW() ELSE rate_limit_buckets.window_started_at END,
              request_count = CASE
                WHEN rate_limit_buckets.window_started_at <= NOW() - ($2::double precision * INTERVAL '1 millisecond')
                THEN 1 ELSE LEAST(rate_limit_buckets.request_count + 1, $3::integer) END
            RETURNING request_count, window_started_at
          `, [bucketKey, windowMs, bucketMax + 1]);
          const bucket = result.rows[0];
          if (bucket && bucket.request_count > bucketMax) {
            const remainingMs = Math.max(0, windowMs - (now - new Date(bucket.window_started_at).getTime()));
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil(remainingMs / 1000))));
            return res.status(429).json({ error: 'rate_limited', message });
          }
        }

        if (now - lastCleanup > 10 * 60 * 1000) {
          await db.query("DELETE FROM rate_limit_buckets WHERE window_started_at < NOW() - INTERVAL '1 day'");
          lastCleanup = now;
        }
        return next();
      }

      if (now - lastCleanup > windowMs) {
        for (const [entryKey, entry] of hits) {
          if (entry.resetAt <= now) hits.delete(entryKey);
        }
        lastCleanup = now;
      }

      for (const { key, max: bucketMax } of keys) {
        let current = hits.get(key);
        if (!current && hits.size >= maxLocalBuckets) {
          if (now - lastCleanup > 1000) {
            for (const [entryKey, entry] of hits) {
              if (entry.resetAt <= now) hits.delete(entryKey);
            }
            lastCleanup = now;
          }
          if (hits.size >= maxLocalBuckets) {
            let nextResetAt = Number.POSITIVE_INFINITY;
            for (const entry of hits.values()) {
              nextResetAt = Math.min(nextResetAt, entry.resetAt);
            }
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil((nextResetAt - now) / 1000))));
            return res.status(429).json({ error: 'rate_limited', message });
          }
          current = hits.get(key);
        }
        if (!current || now >= current.resetAt) {
          hits.set(key, { count: 1, resetAt: now + windowMs });
          continue;
        }

        if (current.count >= bucketMax) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
          return res.status(429).json({ error: 'rate_limited', message });
        }

        current.count += 1;
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
