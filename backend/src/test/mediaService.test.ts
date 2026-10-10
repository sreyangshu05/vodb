import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStorageUrl } from '../services/mediaService.js';

test('protected media storage URLs require public HTTP(S) destinations', () => {
  assert.equal(validateStorageUrl('https://cdn.example.com/media/image.webp'), 'https://cdn.example.com/media/image.webp');
  for (const url of [
    'javascript:alert(1)',
    'https://user:password@cdn.example.com/image.webp',
    'http://localhost/private',
    'http://127.0.0.1/private',
    'http://10.0.0.5/private',
    'http://192.168.1.10/private',
    'http://100.64.0.1/private',
    'http://192.0.2.1/private',
    'http://198.18.0.1/private',
    'http://203.0.113.10/private',
    'http://[::1]/private',
    'http://[::ffff:127.0.0.1]/private',
    'http://[::ffff:10.0.0.1]/private',
  ]) {
    assert.throws(
      () => validateStorageUrl(url),
      (error: unknown) => error instanceof Error && 'error' in error && error.error === 'media_storage_unavailable',
      `Expected URL to be rejected: ${url}`,
    );
  }
});

test('normalizes valid HTTP(S) storage URLs using the URL parser', () => {
  assert.equal(validateStorageUrl('HTTPS://CDN.EXAMPLE.COM:443/media/image.webp'), 'https://cdn.example.com/media/image.webp');
  assert.equal(validateStorageUrl('https://cdn.example.com/a/../media/image.webp'), 'https://cdn.example.com/media/image.webp');
});

test('rejects malformed URLs, unsupported schemes, and local or literal hosts with a stable public error', () => {
  for (const url of [
    '',
    'not a URL',
    '//cdn.example.com/media/image.webp',
    'ftp://cdn.example.com/media/image.webp',
    'file:///etc/passwd',
    'https://printer.local/media/image.webp',
    'https://service.localhost/media/image.webp',
    'https://[2001:db8::1]/media/image.webp',
  ]) {
    assert.throws(
      () => validateStorageUrl(url),
      (error: unknown) => error instanceof Error
        && error.message === 'Protected media storage is temporarily unavailable.'
        && 'status' in error && error.status === 503
        && 'error' in error && error.error === 'media_storage_unavailable',
      `Expected a stable storage error for: ${url}`,
    );
  }
});
