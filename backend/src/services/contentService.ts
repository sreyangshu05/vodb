import { db } from '../lib/db.js';
import { AppError } from '../utils/errors.js';
import type { BlogRecord, EventRecord } from '../types/api.js';

function isDbUnavailable(error: unknown): boolean {
  return error instanceof Error && (
    /ECONNREFUSED|connect ECONNREFUSED|password authentication failed|authentication failed|database.*(not|is).*available|timeout of|connection.*refused|connection terminated|could not connect to server|server.*(down|unavailable)|FATAL/i.test(error.message) ||
    /Client has encountered a connection error|password authentication failed|could not connect to server/i.test(String(error))
  );
}

export async function listPublishedBlogs(limit = 50, offset = 0) {
  try {
    const result = await db.query<BlogRecord>(`
      SELECT b.id, b.title, b.slug, LEFT(b.content, 320) AS content,
             b.meta_title, b.meta_description, b.published, b.published_at,
             b.created_at, b.updated_at, b.image_media_id,
             GREATEST(1, CEIL(char_length(b.content)::numeric / 1000)::integer) AS read_time_minutes,
             CASE WHEN m.id IS NULL THEN NULL ELSE '/api/v1/media/' || m.id::text END AS image_url,
             m.alt_text AS image_alt
      FROM blog_posts b LEFT JOIN media_assets m ON m.id = b.image_media_id
      WHERE b.published = TRUE AND b.moderation_status = 'approved'
      ORDER BY b.published_at DESC, b.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    return result.rows;
  } catch (error) {
    if (isDbUnavailable(error)) {
      throw new AppError(503, 'content_service_unavailable', 'The content service is temporarily unavailable.');
    }
    throw error;
  }
}

export async function getBlogBySlug(slug: string) {
  try {
    const result = await db.query<BlogRecord>(`
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
  } catch (error) {
    if (isDbUnavailable(error)) {
      throw new AppError(503, 'content_service_unavailable', 'The content service is temporarily unavailable.');
    }
    throw error;
  }
}

export async function listPublishedEvents(limit = 50, offset = 0) {
  try {
    const result = await db.query<EventRecord>(`
      SELECT e.*, CASE WHEN m.id IS NULL THEN NULL ELSE '/api/v1/media/' || m.id::text END AS image_url,
             m.alt_text AS image_alt
      FROM events e LEFT JOIN media_assets m ON m.id = e.image_media_id
      WHERE e.published = TRUE AND e.moderation_status = 'approved'
      ORDER BY e.event_date ASC, e.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    return result.rows;
  } catch (error) {
    if (isDbUnavailable(error)) {
      throw new AppError(503, 'content_service_unavailable', 'The events service is temporarily unavailable.');
    }
    throw error;
  }
}

export async function getEventBySlug(slug: string) {
  try {
    const result = await db.query<EventRecord>(`
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
  } catch (error) {
    if (isDbUnavailable(error)) {
      throw new AppError(503, 'content_service_unavailable', 'The events service is temporarily unavailable.');
    }
    throw error;
  }
}

export type PublishedSearchType = 'all' | 'articles' | 'events';
export type PublishedSearchItem = {
  id: string;
  kind: 'article' | 'event';
  title: string;
  url: string;
  group: 'Articles' | 'Events';
  excerpt: string;
};

export async function searchPublishedContent(query: string, kind: PublishedSearchType = 'all', limit = 20, offset = 0) {
  try {
    const result = await db.query<{
      id: string;
      kind: 'article' | 'event';
      title: string;
      slug: string;
      group_name: 'Articles' | 'Events';
      excerpt: string;
      score: number;
      total: string;
    }>(`
      WITH search_query AS (
        SELECT websearch_to_tsquery('simple'::regconfig, $1) AS value
      ), matches AS (
        SELECT b.id::text AS id, 'article'::text AS kind, b.title, b.slug,
          'Articles'::text AS group_name,
          COALESCE(NULLIF(b.meta_description, ''), LEFT(b.content, 260)) AS excerpt,
          ts_rank(to_tsvector('simple'::regconfig,
            COALESCE(b.title, '') || ' ' || COALESCE(b.meta_title, '') || ' ' || COALESCE(b.meta_description, '') || ' ' || COALESCE(b.content, '')),
            search_query.value) AS score,
          b.published_at AS published_at
        FROM blog_posts b CROSS JOIN search_query
        WHERE $2 IN ('all', 'articles')
          AND b.published = TRUE AND b.moderation_status = 'approved'
          AND to_tsvector('simple'::regconfig,
            COALESCE(b.title, '') || ' ' || COALESCE(b.meta_title, '') || ' ' || COALESCE(b.meta_description, '') || ' ' || COALESCE(b.content, '')) @@ search_query.value
        UNION ALL
        SELECT e.id::text AS id, 'event'::text AS kind, e.title, e.slug,
          'Events'::text AS group_name,
          LEFT(COALESCE(e.location, '') || CASE WHEN e.location IS NULL OR e.location = '' THEN '' ELSE '. ' END || e.description, 260) AS excerpt,
          ts_rank(to_tsvector('simple'::regconfig,
            COALESCE(e.title, '') || ' ' || COALESCE(e.location, '') || ' ' || COALESCE(e.description, '')),
            search_query.value) AS score,
          e.event_date AS published_at
        FROM events e CROSS JOIN search_query
        WHERE $2 IN ('all', 'events')
          AND e.published = TRUE AND e.moderation_status = 'approved'
          AND to_tsvector('simple'::regconfig,
            COALESCE(e.title, '') || ' ' || COALESCE(e.location, '') || ' ' || COALESCE(e.description, '')) @@ search_query.value
      )
      SELECT id, kind, title, slug, group_name, excerpt, score,
        COUNT(*) OVER()::text AS total
      FROM matches
      ORDER BY score DESC, published_at DESC NULLS LAST, title ASC
      LIMIT $3 OFFSET $4
    `, [query, kind, limit, offset]);

    const items: PublishedSearchItem[] = result.rows.map(row => ({
      id: `${row.kind}:${row.id}`,
      kind: row.kind,
      title: row.title,
      url: row.kind === 'article' ? `/blog/${encodeURIComponent(row.slug)}` : `/events/${encodeURIComponent(row.slug)}`,
      group: row.group_name,
      excerpt: row.excerpt,
    }));
    return { items, total: Number(result.rows[0]?.total ?? 0), limit, offset };
  } catch (error) {
    if (isDbUnavailable(error)) throw new AppError(503, 'content_service_unavailable', 'Published content search is temporarily unavailable.');
    throw error;
  }
}
