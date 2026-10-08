import jwt, { type Secret, type SignOptions } from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import argon2 from 'argon2';
import { promisify } from 'node:util';
import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { db } from '../lib/db.js';
import { AppError } from '../utils/errors.js';
import type { AuthUser } from '../types/api.js';
import { logger } from '../utils/logger.js';
import { hashOneTimeCode } from '../utils/otp.js';

const scrypt = promisify(scryptCallback);
const PASSWORD_KEY_LENGTH = 64;
const googleClient = new OAuth2Client();

export async function verifySignupChallenge(token: string | undefined, remoteIp?: string): Promise<void> {
  if (!env.TURNSTILE_SECRET_KEY && env.NODE_ENV !== 'production') return;
  if (!token || token.length > 2048 || !env.TURNSTILE_SECRET_KEY) {
    throw new AppError(400, 'signup_challenge_required', 'Complete the security check before creating an account.');
  }

  let response: Response;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new AppError(503, 'signup_challenge_unavailable', 'The security check is temporarily unavailable. Please try again.');
  }

  if (!response.ok) throw new AppError(503, 'signup_challenge_unavailable', 'The security check is temporarily unavailable. Please try again.');
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new AppError(503, 'signup_challenge_unavailable', 'The security check is temporarily unavailable. Please try again.');
  }
  if (!result || typeof result !== 'object' || !('success' in result) || result.success !== true || !('action' in result) || result.action !== 'signup') {
    throw new AppError(400, 'signup_challenge_failed', 'The security check expired or could not be verified. Please complete it again.');
  }
}

type DecodedGoogleClaims = {
  aud?: string | string[];
  iss?: string;
};

/**
 * Decode only the untrusted JWT payload so we can return a useful
 * configuration error. The token is still verified cryptographically below;
 * this helper must never be used as an authentication check.
 */
function decodeGoogleClaims(idToken: string): DecodedGoogleClaims | null {
  const segments = idToken.split('.');
  if (segments.length !== 3) return null;

  try {
    const base64 = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const parsed: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed as DecodedGoogleClaims : null;
  } catch {
    return null;
  }
}

function googleAudiences(claims: DecodedGoogleClaims | null): string[] {
  if (!claims?.aud) return [];
  return (Array.isArray(claims.aud) ? claims.aud : [claims.aud]).filter(
    (audience): audience is string => typeof audience === 'string',
  );
}

function clientIdHint(clientId: string): string {
  // OAuth client IDs are public identifiers. During local diagnosis show the
  // full values so a stale browser/build can be identified without guessing.
  if (env.NODE_ENV !== 'production') return clientId;
  if (clientId.length <= 24) return clientId;
  return `${clientId.slice(0, 12)}…${clientId.slice(-12)}`;
}

function googleClientMismatchMessage(tokenAudiences: string[] = []): string {
  const received = tokenAudiences.length > 0
    ? tokenAudiences.map(clientIdHint).join(', ')
    : 'unknown';
  return `Google returned OAuth client ${received}, but the backend expects ${clientIdHint(env.GOOGLE_CLIENT_ID!)}. Restart the frontend and backend, then ensure both environment variables use the same client ID.`;
}

function parseLegacyScryptHash(encodedHash: string): { salt: string; storedKey: string } | null {
  const [algorithm, salt, storedKey] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || !salt || !storedKey || !/^[0-9a-f]+$/i.test(storedKey)) return null;
  return { salt, storedKey };
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  if (!encodedHash) return false;

  if (encodedHash.startsWith('$argon2id$')) {
    try {
      return await argon2.verify(encodedHash, password);
    } catch {
      return false;
    }
  }

  const legacyHash = parseLegacyScryptHash(encodedHash);
  if (!legacyHash) return false;

  const derivedKey = (await scrypt(password, legacyHash.salt, PASSWORD_KEY_LENGTH)) as Buffer;
  const expectedKey = Buffer.from(legacyHash.storedKey, 'hex');
  return expectedKey.length === derivedKey.length && timingSafeEqual(expectedKey, derivedKey);
}
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function signToken(user: AuthUser) {
  const configuredAdmin = user.role === 'admin' && user.id.startsWith('admin-');
  let tokenVersion = 0;
  if (USER_ID_PATTERN.test(user.id)) {
    const result = await db.query<{ token_version: number }>(
      'SELECT token_version FROM users WHERE id = $1',
      [user.id],
    );
    if (!result.rows[0]) throw new AppError(401, 'account_not_found', 'The account is no longer available.');
    tokenVersion = result.rows[0].token_version;
  } else if (!configuredAdmin && env.NODE_ENV !== 'test') {
    throw new AppError(401, 'invalid_account_id', 'The account identity is invalid.');
  }
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tokenVersion,
      configuredAdmin,
    },
    env.JWT_SECRET as Secret,
    {
      expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
    }
  );
}

export function verifyToken(token: string) {
  const payload = jwt.verify(token, env.JWT_SECRET);
  if (!payload || typeof payload !== 'object' ||
      typeof payload.sub !== 'string' ||
      typeof payload.email !== 'string' ||
      !['member', 'editor', 'admin'].includes(String(payload.role)) ||
      !Number.isSafeInteger(payload.tokenVersion ?? 0) ||
      Number(payload.tokenVersion ?? 0) < 0) {
    throw new Error('Invalid authentication token claims.');
  }
  return {
    sub: payload.sub,
    email: payload.email,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    role: payload.role as AuthUser['role'],
    tokenVersion: Number(payload.tokenVersion ?? 0),
    configuredAdmin: payload.configuredAdmin === true,
  };
}

export async function registerUser(name: string, email: string, password: string): Promise<AuthUser> {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  try {
    const result = await db.query<{ id: string; name: string; email: string; role: AuthUser['role'] }>(
      `INSERT INTO users (name, email, password_hash, email_verified)
       VALUES ($1, $2, $3, false)
       RETURNING id, name, email, role`,
      [name.trim(), normalizedEmail, passwordHash],
    );
    return result.rows[0];
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw new AppError(409, 'account_already_exists', 'An account with this email already exists.');
    }
    throw error;
  }
}

export async function issueReaderEmailVerification(email: string): Promise<{ email: string; code: string } | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const userResult = await db.query<{ id: string; email: string; email_verified: boolean }>(
    'SELECT id, email, email_verified FROM users WHERE lower(email) = lower($1) LIMIT 1', [normalizedEmail],
  );
  const user = userResult.rows[0];
  if (!user || user.email_verified) return null;
  const code = String(randomInt(100000, 1000000));
  const issuedCode = await db.query<{ user_id: string }>(
    `INSERT INTO reader_email_verification_otps (user_id, code_hash, expires_at)
     VALUES ($1, $2, now() + interval '10 minutes')
     ON CONFLICT (user_id) DO UPDATE SET
       code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at,
       failed_attempts = 0,
       locked_until = NULL,
       created_at = now()
     WHERE (reader_email_verification_otps.locked_until IS NULL OR reader_email_verification_otps.locked_until <= now())
       AND reader_email_verification_otps.created_at <= now() - interval '30 seconds'
     RETURNING user_id`,
    [user.id, hashOneTimeCode(code, env.OTP_HASH_SECRET)],
  );
  if (!issuedCode.rows[0]) {
    return null;
  }
  return { email: user.email, code };
}

export async function verifyReaderEmail(email: string, code: string): Promise<AuthUser> {
  const normalizedEmail = email.trim().toLowerCase();
  const codeHash = hashOneTimeCode(code, env.OTP_HASH_SECRET);
  const result = await db.query<AuthUser>(
    `WITH consumed_code AS (
       DELETE FROM reader_email_verification_otps otp
       USING users u
       WHERE otp.user_id = u.id AND lower(u.email) = lower($1)
         AND otp.code_hash = $2 AND otp.expires_at > now()
         AND otp.failed_attempts < 5
         AND (otp.locked_until IS NULL OR otp.locked_until <= now())
       RETURNING otp.user_id
     )
     UPDATE users SET email_verified = true, updated_at = now()
     WHERE id IN (SELECT user_id FROM consumed_code)
     RETURNING id, name, email, role`,
    [normalizedEmail, codeHash],
  );
  if (!result.rows[0]) {
    await db.query(
      `UPDATE reader_email_verification_otps otp
       SET failed_attempts = otp.failed_attempts + 1,
           locked_until = CASE
             WHEN otp.failed_attempts + 1 >= 5 THEN now() + interval '15 minutes'
             ELSE otp.locked_until
           END
       FROM users u
       WHERE otp.user_id = u.id
         AND lower(u.email) = lower($1)
         AND otp.code_hash <> $2
         AND otp.expires_at > now()
         AND otp.failed_attempts < 5
         AND (otp.locked_until IS NULL OR otp.locked_until <= now())`,
      [normalizedEmail, codeHash],
    );
    throw new AppError(400, 'invalid_or_expired_verification_code', 'That verification code is invalid or has expired. Request a new code and try again.');
  }
  return result.rows[0];
}

export async function authenticateUser(email: string, password: string): Promise<AuthUser> {
  const result = await db.query<{ id: string; name: string; email: string; role: AuthUser['role']; password_hash: string; email_verified: boolean }>(
    `SELECT id, name, email, role, password_hash, email_verified FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [email.trim()],
  );
  const user = result.rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
  }
  if (!user.email_verified) throw new AppError(403, 'email_not_verified', 'Verify your email address before signing in. Check your inbox for the code or request a new one.');
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

export async function authenticateGoogleUser(idToken: string): Promise<AuthUser> {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new AppError(503, 'google_auth_unavailable', 'Google sign-in is not configured.');
  }

  const decodedClaims = decodeGoogleClaims(idToken);
  const tokenAudiences = googleAudiences(decodedClaims);
  if (tokenAudiences.length > 0 && !tokenAudiences.includes(env.GOOGLE_CLIENT_ID)) {
    logger.warn('google_client_mismatch', {
      configuredClientId: env.GOOGLE_CLIENT_ID,
      tokenAudience: tokenAudiences,
    });
    throw new AppError(
      401,
      'google_client_mismatch',
      googleClientMismatchMessage(tokenAudiences),
    );
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|network|socket|429|5\d\d/i.test(message)) {
      logger.error('google_provider_unavailable', { message });
      throw new AppError(503, 'google_auth_unavailable', 'Google sign-in is temporarily unavailable.');
    }
    logger.warn('google_token_rejected', {
      reason: message,
      configuredClientId: env.GOOGLE_CLIENT_ID,
    });
    if (/audience|azp|client.?id|recipient/i.test(message)) {
      throw new AppError(
        401,
        'google_client_mismatch',
        googleClientMismatchMessage(googleAudiences(decodedClaims)),
      );
    }
    if (/expired|too late|issued at|iat|exp/i.test(message)) {
      throw new AppError(401, 'google_token_expired', 'The Google sign-in token expired. Please try again.');
    }
    throw new AppError(401, 'invalid_google_token', 'Google sign-in could not be verified. Check the Google OAuth client configuration and try again.');
  }

  if (!payload?.sub || !payload.email || payload.email_verified !== true) {
    throw new AppError(401, 'invalid_google_account', 'Google sign-in requires a verified email address.');
  }

  const normalizedEmail = payload.email.trim().toLowerCase();
  const existing = await db.query<{ id: string; name: string; email: string; role: AuthUser['role'] }>(
    `SELECT id, name, email, role FROM users
     WHERE google_subject = $1 OR lower(email) = lower($2)
     LIMIT 1`,
    [payload.sub, normalizedEmail],
  );

  if (existing.rows[0]) {
    const user = existing.rows[0];
    await db.query(
      `UPDATE users SET google_subject = $1, auth_provider = 'google', email_verified = true, updated_at = now()
       WHERE id = $2`,
      [payload.sub, user.id],
    );
    return user;
  }

  const passwordHash = await hashPassword(randomBytes(32).toString('hex'));
  try {
    const result = await db.query<{ id: string; name: string; email: string; role: AuthUser['role'] }>(
      `INSERT INTO users (name, email, password_hash, auth_provider, google_subject)
       VALUES ($1, $2, $3, 'google', $4)
       RETURNING id, name, email, role`,
      [payload.name?.trim() || normalizedEmail.split('@')[0], normalizedEmail, passwordHash, payload.sub],
    );
    return result.rows[0];
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw new AppError(409, 'account_already_exists', 'This Google account is already being linked. Please try again.');
    }
    throw error;
  }
}

export async function createPasswordReset(email: string): Promise<{ email: string; code: string } | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const userResult = await db.query<{ id: string; email: string }>(
    'SELECT id, email FROM users WHERE lower(email) = lower($1) LIMIT 1',
    [normalizedEmail],
  );
  const user = userResult.rows[0];
  if (!user) return null;

  const code = String(randomInt(100000, 1000000));
  const issuedCode = await db.query<{ user_id: string }>(
    `INSERT INTO password_reset_otps (user_id, code_hash, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 minute'))
     ON CONFLICT (user_id) DO UPDATE SET
       code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at,
       failed_attempts = 0,
       locked_until = NULL,
       created_at = now()
     WHERE (password_reset_otps.locked_until IS NULL OR password_reset_otps.locked_until <= now())
       AND password_reset_otps.created_at <= now() - interval '30 seconds'
     RETURNING user_id`,
    [user.id, hashOneTimeCode(code, env.OTP_HASH_SECRET), env.PASSWORD_RESET_OTP_TTL_MINUTES],
  );
  if (!issuedCode.rows[0]) return null;
  return { email: user.email, code };
}

export async function discardPasswordReset(email: string): Promise<void> {
  await db.query(
    `DELETE FROM password_reset_otps otp
     USING users u
     WHERE otp.user_id = u.id AND lower(u.email) = lower($1)`,
    [email.trim()],
  );
}

export async function resetPassword(email: string, code: string, password: string): Promise<AuthUser> {
  const normalizedEmail = email.trim().toLowerCase();
  const codeHash = hashOneTimeCode(code, env.OTP_HASH_SECRET);
  const validOtp = await db.query<{ id: string }>(
    `SELECT otp.user_id AS id
     FROM password_reset_otps otp
     JOIN users u ON otp.user_id = u.id
     WHERE lower(u.email) = lower($1)
       AND otp.code_hash = $2
       AND otp.expires_at > now()
       AND otp.failed_attempts < 5
       AND (otp.locked_until IS NULL OR otp.locked_until <= now())
     LIMIT 1`,
    [normalizedEmail, codeHash],
  );
  if (!validOtp.rows[0]) {
    await db.query(
      `UPDATE password_reset_otps otp
       SET failed_attempts = otp.failed_attempts + 1,
           locked_until = CASE
             WHEN otp.failed_attempts + 1 >= 5 THEN now() + interval '15 minutes'
             ELSE otp.locked_until
           END
       FROM users u
       WHERE otp.user_id = u.id
         AND lower(u.email) = lower($1)
         AND otp.code_hash <> $2
         AND otp.expires_at > now()
         AND otp.failed_attempts < 5
         AND (otp.locked_until IS NULL OR otp.locked_until <= now())`,
      [normalizedEmail, codeHash],
    );
    throw new AppError(400, 'invalid_or_expired_otp', 'That OTP is invalid or has expired.');
  }

  const passwordHash = await hashPassword(password);
  const result = await db.query<AuthUser>(
    `WITH consumed_otp AS (
       DELETE FROM password_reset_otps otp
       USING users u
       WHERE otp.user_id = u.id
         AND lower(u.email) = lower($1)
         AND otp.code_hash = $2
         AND otp.expires_at > now()
         AND otp.failed_attempts < 5
         AND (otp.locked_until IS NULL OR otp.locked_until <= now())
       RETURNING otp.user_id
     )
     UPDATE users
     SET password_hash = $3, token_version = token_version + 1, updated_at = now()
     WHERE id IN (SELECT user_id FROM consumed_otp)
     RETURNING id, name, email, role`,
    [normalizedEmail, codeHash, passwordHash],
  );
  if (!result.rows[0]) {
    throw new AppError(400, 'invalid_or_expired_otp', 'That OTP is invalid or has expired.');
  }
  return result.rows[0];
}

export async function verifyAdminPassword(password: string) {
  if (env.ADMIN_PASSWORD_HASH) {
    if (env.ADMIN_PASSWORD_HASH.startsWith('$argon2id$')) {
      try {
        return await argon2.verify(env.ADMIN_PASSWORD_HASH, password);
      } catch {
        return false;
      }
    }

    const [algorithm, salt, encodedHash] = env.ADMIN_PASSWORD_HASH.split('$');
    if (algorithm !== 'scrypt' || !salt || !encodedHash) return false;
    const derived = (await scrypt(password, Buffer.from(salt, 'base64'), 64)) as Buffer;
    const expected = Buffer.from(encodedHash, 'base64');
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  }
  return password === env.ADMIN_PASSWORD;
}

export async function hashAdminPassword(password: string) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
}

export function getMockAdminUser(email = env.ADMIN_EMAIL) {
  return { id: `admin-${email.toLowerCase()}`, email, role: 'admin' as const };
}
