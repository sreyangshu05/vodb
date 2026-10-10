import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../lib/db.js';
import { listPublishedBlogs, listPublishedEvents, searchPublishedContent } from '../services/contentService.js';

test('public content feeds and search use deterministic unique tie-breakers', async () => {
  const statements: string[] = [];
  const originalQuery = db.query;
  db.query = (async (sql: string) => {
    statements.push(sql);
    return { rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] };
  }) as unknown as typeof db.query;

  try {
    await listPublishedBlogs();
    await listPublishedEvents();
    await searchPublishedContent('Bengal history');
  } finally {
    db.query = originalQuery;
  }

  assert.match(statements[0] ?? '', /ORDER BY b\.published_at DESC, b\.created_at DESC, b\.id ASC/);
  assert.match(statements[1] ?? '', /ORDER BY e\.event_date ASC, e\.created_at DESC, e\.id ASC/);
  assert.match(statements[2] ?? '', /ORDER BY score DESC, published_at DESC NULLS LAST, title ASC, kind ASC, id ASC/);
  for (const statement of statements) {
    assert.match(statement, /LIMIT \$[0-9]+/);
    assert.match(statement, /OFFSET \$[0-9]+/);
  }
});
