import { db } from '../lib/db.js';
import { AppError } from '../utils/errors.js';
function isDbUnavailable(error) {
    return error instanceof Error && (/ECONNREFUSED|connect ECONNREFUSED|password authentication failed|authentication failed|database.*(not|is).*available|timeout of|connection.*refused|connection terminated|could not connect to server|server.*(down|unavailable)|FATAL/i.test(error.message) ||
        /Client has encountered a connection error|password authentication failed|could not connect to server/i.test(String(error)));
}
export async function listPublishedBlogs(limit = 50, offset = 0) {
    try {
        const result = await db.query(`
      SELECT b.*, CASE WHEN m.id IS NULL THEN NULL ELSE '/api/v1/media/' || m.id::text END AS image_url,
             m.alt_text AS image_alt
      FROM blog_posts b LEFT JOIN media_assets m ON m.id = b.image_media_id
      WHERE b.published = TRUE AND b.moderation_status = 'approved'
      ORDER BY b.published_at DESC, b.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
        return result.rows;
    }
    catch (error) {
        if (isDbUnavailable(error)) {
            throw new AppError(503, 'content_service_unavailable', 'The content service is temporarily unavailable.');
        }
        throw error;
    }
}
export async function getBlogBySlug(slug) {
    try {
        const result = await db.query(`
      SELECT b.*, CASE WHEN m.id IS NULL THEN NULL ELSE '/api/v1/media/' || m.id::text END AS image_url,
             m.alt_text AS image_alt
      FROM blog_posts b LEFT JOIN media_assets m ON m.id = b.image_media_id
      WHERE b.slug = $1 AND b.published = TRUE AND b.moderation_status = 'approved'
      LIMIT 1
    `, [slug]);
        const blog = result.rows[0];
        if (!blog) {
            throw new AppError(404, 'blog_not_found', 'Blog post not found.');
        }
        return blog;
    }
    catch (error) {
        if (isDbUnavailable(error)) {
            throw new AppError(503, 'content_service_unavailable', 'The content service is temporarily unavailable.');
        }
        throw error;
    }
}
export async function listPublishedEvents(limit = 50, offset = 0) {
    try {
        const result = await db.query(`
      SELECT e.*, CASE WHEN m.id IS NULL THEN NULL ELSE '/api/v1/media/' || m.id::text END AS image_url,
             m.alt_text AS image_alt
      FROM events e LEFT JOIN media_assets m ON m.id = e.image_media_id
      WHERE e.published = TRUE AND e.moderation_status = 'approved'
      ORDER BY e.event_date ASC, e.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
        return result.rows;
    }
    catch (error) {
        if (isDbUnavailable(error)) {
            throw new AppError(503, 'content_service_unavailable', 'The events service is temporarily unavailable.');
        }
        throw error;
    }
}
export async function getEventBySlug(slug) {
    try {
        const result = await db.query(`
      SELECT e.*, CASE WHEN m.id IS NULL THEN NULL ELSE '/api/v1/media/' || m.id::text END AS image_url,
             m.alt_text AS image_alt
      FROM events e LEFT JOIN media_assets m ON m.id = e.image_media_id
      WHERE e.slug = $1 AND e.published = TRUE AND e.moderation_status = 'approved'
      LIMIT 1
    `, [slug]);
        const event = result.rows[0];
        if (!event) {
            throw new AppError(404, 'event_not_found', 'Event not found.');
        }
        return event;
    }
    catch (error) {
        if (isDbUnavailable(error)) {
            throw new AppError(503, 'content_service_unavailable', 'The events service is temporarily unavailable.');
        }
        throw error;
    }
}
