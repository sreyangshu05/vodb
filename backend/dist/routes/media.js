import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { createMediaAccess, resolveMediaToken } from '../services/mediaService.js';
import { AppError } from '../utils/errors.js';
import { db } from '../lib/db.js';
const router = Router();
const mediaId = z.string().uuid();
const maxImageBytes = 5 * 1024 * 1024;
router.post('/upload', requireAdmin, async (req, res, next) => {
    try {
        const { data, mimeType, fileName, altText } = req.body ?? {};
        if (typeof data !== 'string' || data.length > Math.ceil(maxImageBytes * 4 / 3) + 16) {
            throw new AppError(413, 'image_too_large', 'Image must be 5 MB or smaller.');
        }
        const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
        if (!match || (mimeType && mimeType !== match[1]))
            throw new AppError(422, 'invalid_image', 'Upload a JPEG, PNG, or WebP image.');
        const bytes = Buffer.from(match[2], 'base64');
        if (!bytes.length || bytes.length > maxImageBytes || bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) {
            throw new AppError(bytes.length > maxImageBytes ? 413 : 422, 'invalid_image', 'Image data is invalid or exceeds 5 MB.');
        }
        const signatureValid = match[1] === 'image/jpeg'
            ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
            : match[1] === 'image/png'
                ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
        if (!signatureValid)
            throw new AppError(422, 'invalid_image', 'Image content does not match its file type.');
        if (typeof altText !== 'undefined' && (typeof altText !== 'string' || altText.length > 500))
            throw new AppError(422, 'invalid_alt_text', 'Alt text must be 500 characters or fewer.');
        const result = await db.query('INSERT INTO media_assets (original_name, mime_type, byte_size, image_data, alt_text) VALUES ($1, $2, $3, $4, $5) RETURNING id', [typeof fileName === 'string' ? fileName.slice(0, 255) : 'image', match[1], bytes.length, bytes, altText ?? '']);
        const id = result.rows[0].id;
        res.status(201).json({ id, url: `/api/v1/media/${id}`, mimeType: match[1], byteSize: bytes.length, altText: altText ?? '' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/source', async (req, res, next) => {
    try {
        const sourcePath = z.string().trim().min(1).max(500).parse(req.query.path);
        const result = await db.query('SELECT id, image_data, mime_type, byte_size FROM media_assets WHERE source_path = $1', [sourcePath]);
        const image = result.rows[0];
        if (!image)
            throw new AppError(404, 'image_not_found', 'Site image has not been imported into the database.');
        res.set({ 'Content-Type': image.mime_type, 'Content-Length': String(image.byte_size), 'Cache-Control': 'public, max-age=86400, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
        res.send(image.image_data);
    }
    catch (error) {
        if (error instanceof z.ZodError)
            return next(new AppError(400, 'invalid_image_path', 'A valid image path is required.'));
        next(error);
    }
});
router.get('/:id', async (req, res, next) => {
    try {
        const parsed = mediaId.safeParse(req.params.id);
        if (!parsed.success)
            throw new AppError(400, 'invalid_media_id', 'Media id must be a UUID.');
        const result = await db.query(`SELECT m.image_data, m.mime_type, m.byte_size, m.alt_text
       FROM media_assets m
       WHERE m.id = $1 AND (
         EXISTS (SELECT 1 FROM blog_posts b WHERE b.image_media_id = m.id AND b.published = TRUE AND b.moderation_status = 'approved') OR
         EXISTS (SELECT 1 FROM events e WHERE e.image_media_id = m.id AND e.published = TRUE AND e.moderation_status = 'approved')
       )`, [parsed.data]);
        const image = result.rows[0];
        if (!image)
            throw new AppError(404, 'image_not_found', 'Published image not found.');
        res.set({ 'Content-Type': image.mime_type, 'Content-Length': String(image.byte_size), 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
        res.send(image.image_data);
    }
    catch (error) {
        next(error);
    }
});
router.post('/:id/access', requireAuth, async (req, res, next) => {
    try {
        const parsed = mediaId.safeParse(req.params.id);
        if (!parsed.success)
            throw new AppError(400, 'invalid_media_id', 'Media id must be a UUID.');
        const result = await createMediaAccess(parsed.data, req.user.id, {
            ip: req.ip,
            userAgent: req.get('user-agent'),
        });
        res.json({
            media: { id: result.media.id, title: result.media.title, mimeType: result.media.mime_type },
            token: result.token,
            expiresAt: result.expiresAt,
            streamUrl: '/api/v1/media/stream',
        });
    }
    catch (error) {
        next(error);
    }
});
router.get('/stream', async (req, res, next) => {
    try {
        const token = req.get('x-media-access-token');
        if (!token)
            throw new AppError(401, 'missing_media_token', 'A media access token is required.');
        const { media } = await resolveMediaToken(token);
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Type', media.mime_type);
        res.redirect(302, media.storage_url);
    }
    catch (error) {
        next(error);
    }
});
export default router;
