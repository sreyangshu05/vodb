import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { db } from '../lib/db.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

type MediaRow = { id: string; storage_url: string; mime_type: string; title: string };

export function validateStorageUrl(storageUrl: string): string {
  try {
    const parsed = new URL(storageUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('Unsupported storage URL.');
    }
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      throw new Error('Storage URL must use a public host.');
    }
    // Redirect targets are administrator-managed, but accepting IP literals
    // creates an avoidable path to loopback, private, link-local, mapped IPv4,
    // and special-use destinations. Require a DNS hostname for storage URLs.
    const ipHostname = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (isIP(ipHostname) !== 0) {
      throw new Error('Storage URL must use a public DNS host.');
    }
    return parsed.toString();
  } catch {
    throw new AppError(503, 'media_storage_unavailable', 'Protected media storage is temporarily unavailable.');
  }
}

function sign(mediaId: string, userId: string, expires: number) {
  const payload = `${mediaId}.${userId}.${expires}`;
  const signature = crypto.createHmac('sha256', env.MEDIA_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verify(token: string) {
  const [mediaId, userId, expiresText, signature] = token.split('.');
  const expires = Number(expiresText);
  if (!mediaId || !userId || !signature || !Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) {
    throw new AppError(401, 'expired_media_token', 'The media access token is invalid or expired.');
  }
  const expected = sign(mediaId, userId, expires).split('.').pop();
  if (!expected || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new AppError(401, 'invalid_media_token', 'The media access token is invalid.');
  }
  return { mediaId, userId };
}

export async function createMediaAccess(mediaId: string, userId: string, request: { ip?: string; userAgent?: string }) {
  const result = await db.query<MediaRow>(
    'SELECT id, storage_url, mime_type, title FROM protected_media WHERE id = $1 AND is_active = TRUE AND (owner_user_id = $2 OR is_shared = TRUE)',
    [mediaId, userId],
  );
  const media = result.rows[0];
  if (!media) throw new AppError(404, 'media_not_found', 'Protected media was not found.');
  validateStorageUrl(media.storage_url);
  const expires = Math.floor(Date.now() / 1000) + env.MEDIA_TOKEN_TTL_SECONDS;
  const token = sign(media.id, userId, expires);
  await db.query(
    'INSERT INTO protected_media_access_log (media_id, user_id, expires_at, ip_address, user_agent) VALUES ($1, $2, to_timestamp($3), $4, $5)',
    [media.id, userId, expires, request.ip ?? null, request.userAgent ?? null],
  );
  return { media, token, expiresAt: new Date(expires * 1000).toISOString() };
}

export async function resolveMediaToken(token: string) {
  const { mediaId, userId } = verify(token);
  const result = await db.query<MediaRow>(
    `SELECT id, storage_url, mime_type, title
     FROM protected_media
     WHERE id = $1 AND is_active = TRUE AND (owner_user_id = $2 OR is_shared = TRUE)`,
    [mediaId, userId],
  );
  const media = result.rows[0];
  if (!media) throw new AppError(404, 'media_not_found', 'Protected media was not found.');
  media.storage_url = validateStorageUrl(media.storage_url);
  return { media, userId };
}
