import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assertProductionDatabaseTls } from './databaseTls.js';

// Resolve the backend environment file from this module instead of the current
// shell directory. This keeps GOOGLE_CLIENT_ID and the other backend settings
// loaded when the server is started from the repository root.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'true';
  }
  return value;
}, z.boolean());

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  JWT_SECRET: z.string().min(16).default('development-secret-change-me'),
  JWT_EXPIRES_IN: z.string().default('1h'),
  DATABASE_URL: z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional()),
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_DB: z.string().default('appdb'),
  POSTGRES_USER: z.string().default('postgres'),
  POSTGRES_PASSWORD: z.string().default('postgres'),
  POSTGRES_SSL: booleanFromEnv.default(false),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(60),
  CONTACT_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  CONTACT_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(5),
  NEWSLETTER_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  NEWSLETTER_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(10),
  NEWSLETTER_WEBHOOK_SECRET: z.preprocess((value) => value === '' ? undefined : value, z.string().min(16).optional()),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  OBSERVABILITY_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().min(16).optional()),
  NEON_AI_GATEWAY_BASE_URL: z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional()),
  NEON_AI_GATEWAY_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().min(16).optional()),
  NEON_AI_GATEWAY_MODEL: z.string().trim().min(1).optional(),
  ADMIN_EMAIL: z.string().default('admin@voiceofdigi.org'),
  ADMIN_EMAILS: z.string().default(''),
  ADMIN_PASSWORD: z.string().default('admin123'),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  ADMIN_LOGIN_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(5),
  GOOGLE_CLIENT_ID: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  SIGNUP_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  SIGNUP_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(5),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanFromEnv.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.preprocess((value) => value === '' ? undefined : value, z.string().email().optional()),
  PASSWORD_RESET_OTP_TTL_MINUTES: z.coerce.number().int().min(5).max(30).default(10),
  MEDIA_TOKEN_SECRET: z.string().min(16).default('development-media-secret-change-me'),
  MEDIA_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
});

export const env = envSchema.parse(process.env);

if (env.NODE_ENV === 'production') {
  const unsafeDefaults = [
    ...(!env.DATABASE_URL ? [['POSTGRES_PASSWORD', env.POSTGRES_PASSWORD, 'postgres'] as const] : []),
  ] as const;

  for (const [name, value, unsafeValue] of unsafeDefaults) {
    if (value === unsafeValue || value.length < 16) {
      throw new Error(`${name} must be replaced with a secure production value.`);
    }
  }

  if (!env.ADMIN_PASSWORD_HASH) {
    throw new Error('ADMIN_PASSWORD_HASH must be configured in production.');
  }

  if (env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in production.');
  }

  if (env.MEDIA_TOKEN_SECRET.length < 32 || env.MEDIA_TOKEN_SECRET === 'development-media-secret-change-me') {
    throw new Error('MEDIA_TOKEN_SECRET must be a new, random production value of at least 32 characters.');
  }

  if (!env.DATABASE_URL && env.POSTGRES_HOST === 'localhost') {
    throw new Error('DATABASE_URL or a remote POSTGRES_HOST must be configured in production.');
  }

  assertProductionDatabaseTls(env.DATABASE_URL, env.POSTGRES_SSL);

  if (!env.GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_CLIENT_ID must be configured in production.');
  }

  if (!env.TURNSTILE_SECRET_KEY) {
    throw new Error('TURNSTILE_SECRET_KEY must be configured in production.');
  }

  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !env.SMTP_FROM) {
    throw new Error('SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM must be configured in production.');
  }

  if (!env.NEWSLETTER_WEBHOOK_SECRET) {
    throw new Error('NEWSLETTER_WEBHOOK_SECRET must be configured in production.');
  }

  if (!env.OBSERVABILITY_TOKEN) {
    throw new Error('OBSERVABILITY_TOKEN must be configured in production.');
  }

  if (env.NEON_AI_GATEWAY_BASE_URL && !env.NEON_AI_GATEWAY_BASE_URL.startsWith('https://')) {
    throw new Error('NEON_AI_GATEWAY_BASE_URL must use HTTPS in production.');
  }

  const configuredOrigins = env.CORS_ORIGIN.split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean);
  const frontendOrigin = new URL(env.FRONTEND_URL).origin;
  if (!configuredOrigins.includes(frontendOrigin)) {
    throw new Error('CORS_ORIGIN must include FRONTEND_URL.');
  }
}
