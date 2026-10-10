import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('production configuration rejects a plaintext ADMIN_PASSWORD without printing its value', () => {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'test-only-credential-marker',
  };
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/config/env.ts')"],
    { cwd: process.cwd(), env: childEnv, encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ADMIN_PASSWORD must not be configured in production/);
  assert.equal(result.stderr.includes('test-only-credential-marker'), false);
});

test('development configuration blocks remote databases unless explicitly opted in', () => {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://username:private-marker@remote.example.invalid/appdb',
    DIRECT_DATABASE_URL: '',
    SMTP_HOST: '',
    ALLOW_REMOTE_DEVELOPMENT_SERVICES: 'false',
  };
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/config/env.ts')"],
    { cwd: process.cwd(), env: childEnv, encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote services are disabled outside production \(DATABASE_URL\)/);
  assert.equal(result.stderr.includes('private-marker'), false);
  assert.equal(result.stderr.includes('remote.example.invalid'), false);
});

test('test configuration also blocks remote databases unless explicitly opted in', () => {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://username:private-marker@remote.example.invalid/appdb',
    DIRECT_DATABASE_URL: '',
    SMTP_HOST: '',
    ALLOW_REMOTE_DEVELOPMENT_SERVICES: 'false',
  };
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/config/env.ts')"],
    { cwd: process.cwd(), env: childEnv, encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote services are disabled outside production \(DATABASE_URL\)/);
  assert.equal(result.stderr.includes('private-marker'), false);
  assert.equal(result.stderr.includes('remote.example.invalid'), false);
});
