import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function productionEnv(frontendUrl?: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: 'production',
    DATABASE_URL: '',
    DIRECT_DATABASE_URL: '',
    POSTGRES_HOST: 'db.example.invalid',
    POSTGRES_PASSWORD: 'ci-only-database-password-marker',
    POSTGRES_SSL: 'true',
    DATABASE_POOL_MAX: '7',
    ADMIN_PASSWORD_HASH: 'ci-only-argon-hash-marker',
    ADMIN_PASSWORD: '',
    JWT_SECRET: 'ci-only-jwt-secret-marker-0123456789abcdef',
    OTP_HASH_SECRET: 'ci-only-otp-hmac-secret-marker-0123456789abcdef',
    MEDIA_TOKEN_SECRET: 'ci-only-media-token-secret-marker-0123456789abcdef',
    GOOGLE_CLIENT_ID: 'ci-only-client.apps.example.test',
    TURNSTILE_SECRET_KEY: 'ci-only-turnstile-secret-marker',
    SMTP_HOST: 'smtp.example.invalid',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_USER: 'ci-only-mail-user',
    SMTP_PASSWORD: 'ci-only-mail-password-marker',
    SMTP_FROM: 'noreply@example.test',
    NEWSLETTER_WEBHOOK_SECRET: 'ci-only-newsletter-secret-marker',
    OBSERVABILITY_TOKEN: 'ci-only-observability-token-marker',
    CORS_ORIGIN: 'https://voiceofdigibengal.com',
    FRONTEND_URL: frontendUrl ?? '',
  };
}

function importProductionConfig(environment: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/config/env.ts')"],
    { cwd: process.cwd(), env: environment, encoding: 'utf8' },
  );
}

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

test('production configuration requires a public HTTPS frontend origin', () => {
  const result = importProductionConfig(productionEnv(''));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FRONTEND_URL must be a public HTTPS origin in production/);
});

test('production configuration rejects localhost and HTTP frontend origins', () => {
  for (const frontendUrl of ['http://voiceofdigibengal.com', 'https://localhost:5173']) {
    const result = importProductionConfig(productionEnv(frontendUrl));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FRONTEND_URL must be a public HTTPS origin in production/);
  }
});

test('production configuration accepts an explicit public HTTPS frontend origin', () => {
  const result = importProductionConfig(productionEnv('https://voiceofdigibengal.com'));
  assert.equal(result.status, 0, result.stderr);
});
