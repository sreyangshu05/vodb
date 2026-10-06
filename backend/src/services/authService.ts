import jwt, { type Secret, type SignOptions } from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { db } from '../lib/db.js';
import { AppError } from '../utils/errors.js';
import type { AuthUser } from '../types/api.js';
import { logger } from '../utils/logger.js';

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

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = await scrypt(password, salt, PASSWORD_KEY_LENGTH) as Buffer;
  return `scrypt$${salt}$${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const [algorithm, salt, storedKey] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || !salt || !storedKey || !/^[0-9a-f]+$/i.test(storedKey)) return false;
  const derivedKey = await scrypt(password, salt, PASSWORD_KEY_LENGTH) as Buffer;
  const expectedKey = Buffer.from(storedKey, 'hex');
  return expectedKey.length === derivedKey.length && timingSafeEqual(expectedKey, derivedKey);
}
export function signToken(user: AuthUser) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role },
    env.JWT_SECRET as Secret,
    {
      expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
    }
  );
}

export function verifyToken(token: string) {
  return jwt.verify(token, env.JWT_SECRET) as { sub: string; email: string; name?: string; role: AuthUser['role'] };
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
  await db.query(
    `INSERT INTO reader_email_verification_otps (user_id, code_hash, expires_at)
     VALUES ($1, $2, now() + interval '10 minutes')
     ON CONFLICT (user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, created_at = now()`,
    [user.id, hashResetCode(code)],
  );
  return { email: user.email, code };
}

export async function verifyReaderEmail(email: string, code: string): Promise<AuthUser> {
  const normalizedEmail = email.trim().toLowerCase();
  const result = await db.query<AuthUser>(
    `WITH consumed_code AS (
       DELETE FROM reader_email_verification_otps otp
       USING users u
       WHERE otp.user_id = u.id AND lower(u.email) = lower($1)
         AND otp.code_hash = $2 AND otp.expires_at > now()
       RETURNING otp.user_id
     )
     UPDATE users SET email_verified = true, updated_at = now()
     WHERE id IN (SELECT user_id FROM consumed_code)
     RETURNING id, name, email, role`,
    [normalizedEmail, hashResetCode(code)],
  );
  if (!result.rows[0]) {
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

function hashResetCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
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
  await db.query('DELETE FROM password_reset_otps WHERE user_id = $1', [user.id]);
  await db.query(
    `INSERT INTO password_reset_otps (user_id, code_hash, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 minute'))`,
    [user.id, hashResetCode(code), env.PASSWORD_RESET_OTP_TTL_MINUTES],
  );
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

export async function resetPassword(email: string, code: string, password: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  const result = await db.query<{ id: string }>(
    `WITH consumed_otp AS (
       DELETE FROM password_reset_otps otp
       USING users u
       WHERE otp.user_id = u.id
         AND lower(u.email) = lower($1)
         AND otp.code_hash = $2
         AND otp.expires_at > now()
       RETURNING otp.user_id
     )
     UPDATE users
     SET password_hash = $3, updated_at = now()
     WHERE id IN (SELECT user_id FROM consumed_otp)
     RETURNING id`,
    [normalizedEmail, hashResetCode(code), passwordHash],
  );
  if (!result.rows[0]) {
    throw new AppError(400, 'invalid_or_expired_otp', 'That OTP is invalid or has expired.');
  }
}

export async function verifyAdminPassword(password: string) {
  if (env.ADMIN_PASSWORD_HASH) {
    const [algorithm, salt, encodedHash] = env.ADMIN_PASSWORD_HASH.split('$');
    if (algorithm !== 'scrypt' || !salt || !encodedHash) return false;
    const derived = (await scrypt(password, Buffer.from(salt, 'base64'), 64)) as Buffer;
    const expected = Buffer.from(encodedHash, 'base64');
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  }
  return password === env.ADMIN_PASSWORD;
}

export async function hashAdminPassword(password: string) {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function getMockAdminUser(email = env.ADMIN_EMAIL) {
  return { id: `admin-${email.toLowerCase()}`, email, role: 'admin' as const };
}
