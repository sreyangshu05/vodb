import { Router, json, type Request, type Response } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { createMediaAccess, resolveMediaToken } from '../services/mediaService.js';
import { AppError } from '../utils/errors.js';
import { db } from '../lib/db.js';
import sharp from 'sharp';

const router = Router();
const mediaId = z.string().uuid();
const maxImageBytes = 5 * 1024 * 1024;
const maxImagePixels = 25_000_000;
const uploadJsonParser = json({ limit: '7mb' });

function sendPublicImage(req: Request, res: Response, image: {
  image_data: Buffer;
  mime_type: string;
  byte_size: number;
}) {
  const etag = `"${createHash('sha256').update(image.image_data).digest('base64url')}"`;
  res.set({
    'Content-Type': image.mime_type,
    'Content-Length': String(image.byte_size),
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
  });
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  res.send(image.image_data);
}

router.post('/upload', requireAuth, requireAdmin, uploadJsonParser, async (req, res, next) => {
  try {
    const { data, mimeType, fileName, altText } = req.body ?? {};
    if (typeof data !== 'string' || data.length > Math.ceil(maxImageBytes * 4 / 3) + 16) {
      throw new AppError(413, 'image_too_large', 'Image must be 5 MB or smaller.');
    }
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
    if (!match || (mimeType && mimeType !== match[1])) throw new AppError(422, 'invalid_image', 'Upload a JPEG, PNG, or WebP image.');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > maxImageBytes || bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) {
      throw new AppError(bytes.length > maxImageBytes ? 413 : 422, 'invalid_image', 'Image data is invalid or exceeds 5 MB.');
    }
    const signatureValid = match[1] === 'image/jpeg'
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
      : match[1] === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!signatureValid) throw new AppError(422, 'invalid_image', 'Image content does not match its file type.');
    if (typeof altText !== 'undefined' && (typeof altText !== 'string' || altText.length > 500)) throw new AppError(422, 'invalid_alt_text', 'Alt text must be 500 characters or fewer.');
    let normalizedBytes: Buffer;
    try {
      const decoder = sharp(bytes, { limitInputPixels: maxImagePixels, failOn: 'error' });
      const metadata = await decoder.metadata();
      const expectedFormat = match[1] === 'image/jpeg' ? 'jpeg' : match[1] === 'image/png' ? 'png' : 'webp';
      if (metadata.format !== expectedFormat || !metadata.width || !metadata.height || metadata.width * metadata.height > maxImagePixels) {
        throw new Error('Unsupported or oversized image dimensions.');
      }
      const normalized = sharp(bytes, { limitInputPixels: maxImagePixels, failOn: 'error' }).rotate();
      normalizedBytes = match[1] === 'image/jpeg'
        ? await normalized.jpeg({ quality: 88 }).toBuffer()
        : match[1] === 'image/png'
          ? await normalized.png({ compressionLevel: 9 }).toBuffer()
          : await normalized.webp({ quality: 88 }).toBuffer();
    } catch {
      throw new AppError(422, 'invalid_image', 'Image could not be safely decoded. Upload a valid JPEG, PNG, or WebP under 25 megapixels.');
    }
    if (normalizedBytes.length > maxImageBytes) throw new AppError(413, 'image_too_large', 'Normalized image must be 5 MB or smaller.');
    const originalName = typeof fileName === 'string'
      ? fileName.replace(/\\/g, '/').split('/').pop()!.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'image'
      : 'image';
    const result = await db.query<{ id: string }>(
      'INSERT INTO media_assets (original_name, mime_type, byte_size, image_data, alt_text) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [originalName, match[1], normalizedBytes.length, normalizedBytes, typeof altText === 'string' ? altText.trim() : ''],
    );
    const id = result.rows[0]!.id;
    res.status(201).json({ id, url: `/api/v1/media/${id}`, mimeType: match[1], byteSize: bytes.length, altText: altText ?? '' });
  } catch (error) { next(error); }
});

router.get('/source', async (req, res, next) => {
  try {
    const sourcePath = z.string().trim().min(1).max(500).parse(req.query.path);
    const result = await db.query<{ id: string; image_data: Buffer; mime_type: string; byte_size: number }>(
      'SELECT id, image_data, mime_type, byte_size FROM media_assets WHERE source_path = $1', [sourcePath],
    );
    const image = result.rows[0];
    if (!image) throw new AppError(404, 'image_not_found', 'Site image has not been imported into the database.');
    sendPublicImage(req, res, image);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new AppError(400, 'invalid_image_path', 'A valid image path is required.'));
    next(error);
  }
});

router.get('/stream', async (req, res, next) => {
  try {
    const token = req.get('x-media-access-token');
    if (!token) throw new AppError(401, 'missing_media_token', 'A media access token is required.');
    const { media } = await resolveMediaToken(token);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', media.mime_type);
    res.redirect(302, media.storage_url);
  } catch (error) { next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const parsed = mediaId.safeParse(req.params.id);
    if (!parsed.success) throw new AppError(400, 'invalid_media_id', 'Media id must be a UUID.');
    const result = await db.query<{ image_data: Buffer; mime_type: string; byte_size: number; alt_text: string }>(
      `SELECT m.image_data, m.mime_type, m.byte_size, m.alt_text
       FROM media_assets m
       WHERE m.id = $1 AND (
         EXISTS (SELECT 1 FROM blog_posts b WHERE b.image_media_id = m.id AND b.published = TRUE AND b.moderation_status = 'approved') OR
         EXISTS (SELECT 1 FROM events e WHERE e.image_media_id = m.id AND e.published = TRUE AND e.moderation_status = 'approved')
       )`, [parsed.data],
    );
    const image = result.rows[0];
    if (!image) throw new AppError(404, 'image_not_found', 'Published image not found.');
    sendPublicImage(req, res, image);
  } catch (error) { next(error); }
});

router.post('/:id/access', requireAuth, async (req, res, next) => {
  try {
    const parsed = mediaId.safeParse(req.params.id);
    if (!parsed.success) throw new AppError(400, 'invalid_media_id', 'Media id must be a UUID.');
    const result = await createMediaAccess(parsed.data, req.user!.id, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json({
      media: { id: result.media.id, title: result.media.title, mimeType: result.media.mime_type },
      token: result.token,
      expiresAt: result.expiresAt,
      streamUrl: '/api/v1/media/stream',
    });
  } catch (error) { next(error); }
});

export default router;
