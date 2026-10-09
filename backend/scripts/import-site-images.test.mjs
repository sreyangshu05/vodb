import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

function isInsideDirectory(root, candidate) {
  const relativePath = path.relative(root, candidate);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

test('site image import path containment rejects sibling-prefix and traversal paths', () => {
  const imageRoot = path.resolve('repo/frontend/images');
  assert.equal(isInsideDirectory(imageRoot, path.resolve(imageRoot, 'nested/cover.png')), true);
  assert.equal(isInsideDirectory(imageRoot, path.resolve('repo/frontend/images-backup/cover.png')), false);
  assert.equal(isInsideDirectory(imageRoot, path.resolve('repo/secrets/.env')), false);
  assert.equal(isInsideDirectory(imageRoot, imageRoot), false);
});
